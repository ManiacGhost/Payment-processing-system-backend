import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Payment } from '../models/Payment.js';
import { WebhookLog } from '../models/WebhookLog.js';
import { circuitBreaker, locks } from './payments.js';

const router = Router();

function mapStatus(s: string) {
  switch (s) { case 'created': return 'PENDING' as const; case 'authorized': return 'PROCESSING' as const; case 'captured': return 'SUCCESS' as const; default: return 'FAILED' as const; }
}

// POST /api/webhooks/razorpay — public endpoint (no auth, signature verified)
router.post('/razorpay', async (req: Request, res: Response) => {
  const sig = req.headers['x-razorpay-signature'] as string;
  if (sig) {
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(JSON.stringify(req.body)).digest('hex');
    if (expected !== sig) return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body.event;
  const entity = req.body.payload?.payment?.entity;
  if (!entity?.order_id) return res.status(200).send('OK');

  console.log(`[Webhook] ${event} | Order: ${entity.order_id}`);

  try {
    const payment = await Payment.findOne({ razorpayOrderId: entity.order_id });
    if (!payment) {
      await WebhookLog.create({ paymentId: 'UNKNOWN', source: 'razorpay', eventType: event, payload: req.body, result: 'IGNORED' });
      return res.status(200).send('OK');
    }

    let result: 'PROCESSED' | 'IGNORED' | 'CONFLICT' = 'PROCESSED';
    const newStatus = mapStatus(entity.status);

    if (payment.status === 'SUCCESS' || payment.status === 'FAILED') {
      result = payment.status === newStatus ? 'IGNORED' : 'CONFLICT';
      payment.logs.push({ timestamp: new Date(), event: 'WEBHOOK_IGNORED', details: `Already ${payment.status}` });
    } else {
      payment.status = newStatus;
      payment.razorpayPaymentId = entity.id;
      if (entity.status === 'failed') payment.lastError = entity.error_description || 'FAILED';
      payment.logs.push({ timestamp: new Date(), event: 'WEBHOOK_APPLIED', details: `${entity.status} → ${newStatus}` });
    }

    await payment.save();
    await WebhookLog.create({ paymentId: payment._id.toString(), source: 'razorpay', eventType: event, payload: req.body, result });
    res.status(200).json({ result });
  } catch (err: any) {
    console.error('[Webhook Error]:', err.message);
    res.status(500).send('ERROR');
  }
});

// GET /api/webhooks — list webhook logs
router.get('/', async (_req: Request, res: Response) => {
  const logs = await WebhookLog.find().sort({ createdAt: -1 }).limit(50);
  res.json(logs);
});

// GET /api/system/stats
router.get('/stats', async (_req: Request, res: Response) => {
  const [total, pending, processing, success, failed, vol, retries, whCount] = await Promise.all([
    Payment.countDocuments(),
    Payment.countDocuments({ status: 'PENDING' }),
    Payment.countDocuments({ status: 'PROCESSING' }),
    Payment.countDocuments({ status: 'SUCCESS' }),
    Payment.countDocuments({ status: 'FAILED' }),
    Payment.aggregate([{ $match: { status: 'SUCCESS' } }, { $group: { _id: null, t: { $sum: '$amount' } } }]),
    Payment.aggregate([{ $group: { _id: null, t: { $sum: '$retryCount' } } }]),
    WebhookLog.countDocuments(),
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
