import { Router, Response } from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { v4 as uuidv4 } from 'uuid';
import { Payment } from '../models/Payment.js';
import { WebhookLog } from '../models/WebhookLog.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';

const router = Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

// --- Circuit Breaker ---
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  constructor(private threshold = 5, private resetMs = 15000) {}

  get currentState() {
    if (this.state === 'OPEN' && Date.now() - this.lastFailure > this.resetMs) this.state = 'HALF_OPEN';
    return this.state;
  }
  canExecute() { const s = this.currentState; return s === 'CLOSED' || s === 'HALF_OPEN'; }
  recordSuccess() { this.failures = 0; this.state = 'CLOSED'; }
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) { this.state = 'OPEN'; console.log(`[CircuitBreaker] OPEN`); }
  }
  getInfo() { return { state: this.currentState, failures: this.failures, threshold: this.threshold, resetMs: this.resetMs }; }
}
const circuitBreaker = new CircuitBreaker();

// --- Rate Limiter ---
const rateMap = new Map<string, { count: number; resetAt: number }>();
function checkRate(userId: string): boolean {
  const now = Date.now();
  const e = rateMap.get(userId);
  if (!e || now > e.resetAt) { rateMap.set(userId, { count: 1, resetAt: now + 60000 }); return true; }
  if (e.count >= 10) return false;
  e.count++;
  return true;
}

// --- Retry Wrapper ---
async function withRetry<T>(fn: () => Promise<T>, retries = 3, label = 'API'): Promise<T> {
  for (let i = 0; i < retries; i++) {
    if (!circuitBreaker.canExecute()) throw new Error('CIRCUIT_BREAKER_OPEN');
    try { const r = await fn(); circuitBreaker.recordSuccess(); return r; }
    catch (err: any) {
      circuitBreaker.recordFailure();
      if (i === retries - 1) throw err;
      const ms = Math.pow(2, i + 1) * 500;
      console.log(`[Retry] ${label} #${i + 1}: ${err.message}. Backoff ${ms}ms`);
      await new Promise(r => setTimeout(r, ms));
    }
  }
  throw new Error('MAX_RETRIES');
}

// --- Concurrency Lock ---
const locks = new Set<string>();

// --- Razorpay Status Mapping ---
function mapStatus(s: string) {
  switch (s) { case 'created': return 'PENDING'; case 'authorized': return 'PROCESSING'; case 'captured': return 'SUCCESS'; case 'failed': case 'refunded': return 'FAILED'; default: return 'PROCESSING'; }
}

// All routes below are protected
router.use(authenticate);

// POST /api/payments — Create Razorpay order
router.post('/', async (req: AuthRequest, res: Response) => {
  const { amount, currency, idempotencyKey, metadata } = req.body;
  const userId = req.userId!;

  if (!amount || !currency || !idempotencyKey) return res.status(400).json({ error: 'Missing required fields' });
  if (typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!checkRate(userId)) return res.status(429).json({ error: 'Rate limit exceeded' });

  try {
    const existing = await Payment.findOne({ idempotencyKey });
    if (existing) return res.json({ payment: existing, razorpayKeyId: process.env.RAZORPAY_KEY_ID, duplicate: true });

    const order = await withRetry(
      () => razorpay.orders.create({
        amount: Math.round(amount * 100),
        currency: currency.toUpperCase(),
        receipt: idempotencyKey,
        notes: { userId } as any,
      }), 3, 'CreateOrder'
    );

    const payment = await Payment.create({
      userId, amount, currency: currency.toUpperCase(), status: 'PENDING', idempotencyKey,
      razorpayOrderId: order.id, metadata: metadata || {},
      logs: [{ timestamp: new Date(), event: 'ORDER_CREATED', details: `Razorpay: ${order.id}` }],
    });

    console.log(`[Payment] ${payment._id} | ${order.id} | ₹${amount}`);
    res.status(201).json({ payment, razorpayKeyId: process.env.RAZORPAY_KEY_ID, razorpayOrderId: order.id });
  } catch (err: any) {
    console.error('[Payments] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/verify — Verify Razorpay signature
router.post('/verify', async (req: AuthRequest, res: Response) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, paymentId } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing verification fields' });
  }

  if (locks.has(paymentId)) return res.status(409).json({ error: 'Being processed' });
  locks.add(paymentId);

  try {
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    const valid = expected === razorpay_signature;

    const payment = await Payment.findOne({ _id: paymentId, userId: req.userId });
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.status === 'SUCCESS' || payment.status === 'FAILED') {
      return res.json({ payment, verified: valid });
    }

    payment.status = valid ? 'SUCCESS' : 'FAILED';
    payment.razorpayPaymentId = razorpay_payment_id;
    payment.razorpaySignature = razorpay_signature;
    if (!valid) payment.lastError = 'SIGNATURE_MISMATCH';
    payment.logs.push({ timestamp: new Date(), event: valid ? 'VERIFIED' : 'VERIFY_FAILED', details: `PayID: ${razorpay_payment_id}` });
    await payment.save();

    console.log(`[Verify] ${paymentId} → ${payment.status}`);
    res.json({ payment, verified: valid });
  } catch (err: any) {
    res.status(500).json({ error: 'Verification failed' });
  } finally { locks.delete(paymentId); }
});

// POST /api/payments/:id/fail
router.post('/:id/fail', async (req: AuthRequest, res: Response) => {
  const payment = await Payment.findOne({ _id: req.params.id, userId: req.userId });
  if (!payment) return res.status(404).json({ error: 'Not found' });
  if (payment.status === 'SUCCESS') return res.status(409).json({ error: 'Cannot fail successful payment' });

  payment.status = 'FAILED';
  payment.lastError = req.body.reason || 'USER_CANCELLED';
  payment.logs.push({ timestamp: new Date(), event: 'FAILED', details: payment.lastError });
  await payment.save();
  res.json(payment);
});

// GET /api/payments
router.get('/', async (req: AuthRequest, res: Response) => {
  const payments = await Payment.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(50);
  res.json(payments);
});

// GET /api/payments/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const payment = await Payment.findOne({ _id: req.params.id, userId: req.userId });
  if (!payment) return res.status(404).json({ error: 'Not found' });
  res.json(payment);
});

// --- System Stats (exported for use in webhooks too) ---
export { circuitBreaker, locks };
export default router;
