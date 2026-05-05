import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Payment } from '../models/Payment.js';
import { WebhookLog } from '../models/WebhookLog.js';
import { circuitBreaker, locks } from './payments.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();

function mapStatus(s: string) {
  switch (s) { case 'created': return 'PENDING' as const; case 'authorized': return 'PROCESSING' as const; case 'captured': return 'SUCCESS' as const; default: return 'FAILED' as const; }
}

// POST /api/webhooks/razorpay — public endpoint (no auth, signature verified)
router.post('/razorpay', async (req: Request, res: Response) => {
  const sig = req.headers['x-razorpay-signature'] as string;

  // req.body is a raw Buffer here (express.raw middleware applied in index.ts)
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

  if (sig) {
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET!)
      .update(rawBody).digest('hex');
    if (expected !== sig) return res.status(400).json({ error: 'Invalid signature' });
  }

  const parsedBody = JSON.parse(rawBody.toString());
  const event = parsedBody.event;
  const entity = parsedBody.payload?.payment?.entity;
  if (!entity?.order_id) return res.status(200).send('OK');

  console.log(`[Webhook] ${event} | Order: ${entity.order_id}`);

  // --- Duplicate event deduplication ---
  // Razorpay can fire the same event multiple times; guard by paymentId + eventType
  if (entity.id) {
    const alreadyProcessed = await WebhookLog.findOne({ eventType: event, 'payload.payload.payment.entity.id': entity.id, result: 'PROCESSED' });
    if (alreadyProcessed) {
      console.log(`[Webhook] Duplicate event ignored: ${event} | ${entity.id}`);
      return res.status(200).send('OK');
    }
  }

  // --- Concurrency lock (prevent parallel processing of same order) ---
  const lockKey = `webhook:${entity.order_id}`;
  if (locks.has(lockKey)) {
    console.log(`[Webhook] Concurrent webhook for order ${entity.order_id}, returning 429 to trigger Razorpay retry`);
    return res.status(429).send('RETRY');
  }
  locks.add(lockKey);

  try {
    // --- Early callback: retry finding payment up to 3 times with backoff ---
    let payment = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      payment = await Payment.findOne({ razorpayOrderId: entity.order_id });
      if (payment) break;
      if (attempt < 2) {
        console.log(`[Webhook] Payment not found yet (attempt ${attempt + 1}), retrying...`);
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500)); // 500ms, 1s
      }
    }

    if (!payment) {
      // Still not found after retries — log and return 404 so Razorpay retries later
      await WebhookLog.create({ paymentId: 'UNKNOWN', source: 'razorpay', eventType: event, payload: parsedBody, result: 'IGNORED' });
      console.warn(`[Webhook] Order ${entity.order_id} not found after retries — Razorpay will retry`);
      return res.status(404).send('NOT_FOUND');
    }

    let result: 'PROCESSED' | 'IGNORED' | 'CONFLICT' = 'PROCESSED';
    const newStatus = mapStatus(entity.status);

    if (payment.status === 'SUCCESS' || payment.status === 'FAILED') {
      // Terminal state reached — duplicate or conflicting callback
      result = payment.status === newStatus ? 'IGNORED' : 'CONFLICT';
      payment.logs.push({ timestamp: new Date(), event: 'WEBHOOK_IGNORED', details: `Already ${payment.status}, incoming: ${newStatus} (${result})` });
    } else {
      payment.status = newStatus;
      payment.razorpayPaymentId = entity.id;
      if (entity.status === 'failed') payment.lastError = entity.error_description || 'FAILED';
      payment.logs.push({ timestamp: new Date(), event: 'WEBHOOK_APPLIED', details: `${entity.status} → ${newStatus}` });
    }

    await payment.save();
    await WebhookLog.create({ paymentId: payment._id.toString(), source: 'razorpay', eventType: event, payload: parsedBody, result });
    res.status(200).json({ result });
  } catch (err: any) {
    console.error('[Webhook Error]:', err.message);
    res.status(500).send('ERROR');
  } finally {
    locks.delete(lockKey);
  }
});

// GET /api/webhooks — list webhook logs for the authenticated user
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;

  // Find all payment IDs belonging to this user
  const userPayments = await Payment.find({ userId }).select('_id').lean();
  const paymentIds = userPayments.map(p => p._id.toString());

  const logs = await WebhookLog.find({ paymentId: { $in: [...paymentIds, 'UNKNOWN'] } })
    .sort({ createdAt: -1 })
    .limit(50);
  res.json(logs);
});

// GET /api/webhooks/stats — per-user stats
router.get('/stats', authenticate, async (req: AuthRequest, res: Response) => {
  const userId = req.userId!;
  const filter = { userId };

  // aggregate pipelines don't auto-cast strings to ObjectId — must do it explicitly
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const aggFilter = { userId: userObjectId };

  const [total, pending, processing, success, failed, vol, retries, whCount] = await Promise.all([
    Payment.countDocuments(filter),
    Payment.countDocuments({ ...filter, status: 'PENDING' }),
    Payment.countDocuments({ ...filter, status: 'PROCESSING' }),
    Payment.countDocuments({ ...filter, status: 'SUCCESS' }),
    Payment.countDocuments({ ...filter, status: 'FAILED' }),
    // Volume = sum of ALL payment attempts (success + failed), not just SUCCESS
    Payment.aggregate([{ $match: aggFilter }, { $group: { _id: null, t: { $sum: '$amount' } } }]),
    Payment.aggregate([{ $match: aggFilter }, { $group: { _id: null, t: { $sum: '$retryCount' } } }]),
    (async () => {
      const userPayments = await Payment.find(filter).select('_id').lean();
      const ids = userPayments.map(p => p._id.toString());
      return WebhookLog.countDocuments({ paymentId: { $in: ids } });
    })(),
  ]);

  res.json({
    totalPayments: total,
    byStatus: { PENDING: pending, PROCESSING: processing, SUCCESS: success, FAILED: failed },
    totalVolume: vol[0]?.t || 0,
    totalRetries: retries[0]?.t || 0,
    webhooksReceived: whCount,
    circuitBreaker: circuitBreaker.getInfo(),
    activeProcessing: locks.size,
  });
});

export default router;
