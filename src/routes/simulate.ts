import { Router, Response, Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Payment } from '../models/Payment.js';
import { WebhookLog } from '../models/WebhookLog.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { simulateGateway, SimulationScenario } from '../lib/GatewaySimulator.js';
import { retryQueue } from '../lib/RetryQueue.js';
import { circuitBreaker } from './payments.js';

const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// POST /api/simulate/payment
// Creates a simulated payment and processes it through the gateway simulator.
// Body: { amount, currency, scenario: 'success'|'failure'|'timeout'|'network_error'|'partial_failure'|'random' }
// ---------------------------------------------------------------------------
router.post('/payment', async (req: AuthRequest, res: Response) => {
  const { amount = 500, currency = 'INR', scenario = 'random' } = req.body;

  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const validScenarios = ['success', 'failure', 'timeout', 'network_error', 'partial_failure', 'random'];
  if (!validScenarios.includes(scenario)) {
    return res.status(400).json({ error: `Invalid scenario. Must be one of: ${validScenarios.join(', ')}` });
  }

  const idempotencyKey = `sim_${uuidv4()}`;
  const payment = await Payment.create({
    userId: req.userId!,
    amount,
    currency: currency.toUpperCase(),
    status: 'PENDING',
    idempotencyKey,
    metadata: { simulated: true, requestedScenario: scenario },
    logs: [{ timestamp: new Date(), event: 'SIM_INITIATED', details: `Scenario: ${scenario}` }],
  });

  const paymentId = payment._id.toString();
  console.log(`[Simulate] Payment ${paymentId} | scenario: ${scenario}`);

  // Move to PROCESSING
  payment.status = 'PROCESSING';
  payment.logs.push({ timestamp: new Date(), event: 'SIM_PROCESSING', details: 'Calling simulated gateway' });
  await payment.save();

  const startTime = Date.now();

  try {
    const result = await simulateGateway({ paymentId, amount, currency, scenario: scenario as SimulationScenario });

    payment.status = 'SUCCESS';
    payment.razorpayPaymentId = result.gatewayTransactionId;
    payment.logs.push({
      timestamp: new Date(),
      event: 'SIM_SUCCESS',
      details: `txn: ${result.gatewayTransactionId} | delay: ${result.delayMs}ms | attempts: ${result.attempts}`,
    });
    await payment.save();

    return res.status(200).json({
      payment,
      simulation: { scenario: result.scenario, delayMs: result.delayMs, attempts: result.attempts, message: result.message },
    });
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    payment.status = 'FAILED';
    payment.lastError = err.message;
    payment.logs.push({
      timestamp: new Date(),
      event: 'SIM_FAILED',
      details: `code: ${err.code || 'UNKNOWN'} | ${err.message} | elapsed: ${elapsed}ms`,
    });
    await payment.save();

    return res.status(200).json({
      payment,
      simulation: { scenario: err.scenario || scenario, error: err.message, code: err.code, elapsedMs: elapsed },
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/simulate/payment/retry
// Creates a payment with 'partial_failure' scenario to demonstrate retry logic.
// The gateway fails 2 times then succeeds on the 3rd attempt.
// ---------------------------------------------------------------------------
router.post('/payment/retry', async (req: AuthRequest, res: Response) => {
  const { amount = 500, currency = 'INR' } = req.body;
  const idempotencyKey = `sim_retry_${uuidv4()}`;

  const payment = await Payment.create({
    userId: req.userId!,
    amount,
    currency: currency.toUpperCase(),
    status: 'PENDING',
    idempotencyKey,
    metadata: { simulated: true, requestedScenario: 'partial_failure' },
    logs: [{ timestamp: new Date(), event: 'SIM_INITIATED', details: 'Scenario: partial_failure (queued retry)' }],
  });

  const paymentId = payment._id.toString();
  const attempts: string[] = [];

  // Use retryQueue to demonstrate queue-based retry with backoff
  retryQueue.enqueue(
    paymentId,
    () => simulateGateway({ paymentId, amount, currency, scenario: 'partial_failure' }),
    async (result) => {
      await Payment.findByIdAndUpdate(paymentId, {
        status: 'SUCCESS',
        razorpayPaymentId: result.gatewayTransactionId,
        $push: {
          logs: {
            timestamp: new Date(),
            event: 'SIM_QUEUE_SUCCESS',
            details: `Succeeded after ${result.attempts} attempts via queue`,
          },
        },
      });
      console.log(`[Simulate] Queue retry succeeded for ${paymentId}`);
    },
    async (err) => {
      await Payment.findByIdAndUpdate(paymentId, {
        status: 'FAILED',
        lastError: err.message,
        $push: { logs: { timestamp: new Date(), event: 'SIM_QUEUE_FAILED', details: err.message } },
      });
    },
    { maxAttempts: 5, baseDelayMs: 500, label: `SimRetry:${paymentId}` }
  );

  return res.status(202).json({
    payment,
    message: 'Queued for retry simulation. Poll GET /api/payments/:id to watch status update.',
    hint: 'The gateway will fail attempts 1 and 2, succeed on attempt 3.',
  });
});

// ---------------------------------------------------------------------------
// POST /api/simulate/circuit-breaker
// Fires N rapid failures to trip the circuit breaker, then shows its state.
// Body: { failures: 6 }
// ---------------------------------------------------------------------------
router.post('/circuit-breaker', async (req: AuthRequest, res: Response) => {
  const { failures = 6 } = req.body;
  const results: string[] = [];

  for (let i = 0; i < failures; i++) {
    try {
      await simulateGateway({ paymentId: `cb_test_${i}`, amount: 1, currency: 'INR', scenario: 'failure' });
    } catch (err: any) {
      circuitBreaker.recordFailure();
      results.push(`Failure ${i + 1}: ${err.message}`);
    }
  }

  return res.json({
    message: `Triggered ${failures} failures`,
    results,
    circuitBreaker: circuitBreaker.getInfo(),
  });
});

// ---------------------------------------------------------------------------
// POST /api/simulate/circuit-breaker/reset
// Simulates recovery — records a success to close the circuit breaker.
// ---------------------------------------------------------------------------
router.post('/circuit-breaker/reset', async (_req: AuthRequest, res: Response) => {
  const before = circuitBreaker.getInfo();
  circuitBreaker.recordSuccess();
  const after = circuitBreaker.getInfo();
  return res.json({ message: 'Circuit breaker reset', before, after });
});

// ---------------------------------------------------------------------------
// GET /api/simulate/scenarios
// Returns all available scenarios with descriptions.
// ---------------------------------------------------------------------------
router.get('/scenarios', (_req, res) => {
  res.json({
    scenarios: [
      { name: 'success',         description: 'Gateway processes payment successfully after 100–600ms delay' },
      { name: 'failure',         description: 'Gateway declines the payment (e.g., insufficient funds)' },
      { name: 'timeout',         description: 'Gateway hangs for 11s — triggers timeout handling' },
      { name: 'network_error',   description: 'Connection refused — simulates network outage' },
      { name: 'partial_failure', description: 'Fails on attempts 1 and 2, succeeds on attempt 3 — demonstrates retry' },
      { name: 'random',          description: 'Weighted random: 60% success, 20% failure, 10% timeout, 10% network error' },
    ],
  });
});

// ---------------------------------------------------------------------------
// POST /api/simulate/webhook/early
// Fires a webhook for an order_id that does NOT exist in the DB yet.
// Demonstrates: early callback handling — server retries findOne, then returns
// 404 so Razorpay knows to retry the webhook later.
// ---------------------------------------------------------------------------
router.post('/webhook/early', async (req: AuthRequest, res: Response) => {
  const fakeOrderId = `order_early_${uuidv4().slice(0, 8)}`;

  const webhookPayload = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: `pay_early_${uuidv4().slice(0, 8)}`,
          order_id: fakeOrderId,
          status: 'captured',
          amount: 50000,
        },
      },
    },
  };

  // Internally call the webhook handler logic inline to show the behaviour
  const payment = await Payment.findOne({ razorpayOrderId: fakeOrderId });

  if (!payment) {
    await WebhookLog.create({
      paymentId: 'UNKNOWN',
      source: 'razorpay',
      eventType: webhookPayload.event,
      payload: webhookPayload,
      result: 'IGNORED',
    });
    return res.status(200).json({
      scenario: 'early_callback',
      description: 'Webhook arrived before payment record existed in DB',
      fakeOrderId,
      webhookResult: 'IGNORED — logged as UNKNOWN, real handler returns 404 to trigger Razorpay retry',
      webhookLogCreated: true,
    });
  }

  return res.json({ scenario: 'early_callback', note: 'Payment was found (not truly an early callback)' });
});

// ---------------------------------------------------------------------------
// POST /api/simulate/webhook/duplicate
// Creates a real payment then fires the same webhook event twice rapidly.
// Demonstrates: duplicate deduplication — second event is IGNORED.
// ---------------------------------------------------------------------------
router.post('/webhook/duplicate', async (req: AuthRequest, res: Response) => {
  const idempotencyKey = `sim_wh_dup_${uuidv4()}`;
  const payment = await Payment.create({
    userId: req.userId!,
    amount: 500,
    currency: 'INR',
    status: 'PENDING',
    idempotencyKey,
    metadata: { simulated: true, scenario: 'duplicate_webhook' },
    logs: [{ timestamp: new Date(), event: 'SIM_INITIATED', details: 'duplicate webhook test' }],
  });

  const entity = {
    id: `pay_dup_${uuidv4().slice(0, 8)}`,
    order_id: `order_dup_${uuidv4().slice(0, 8)}`,
    status: 'captured',
    amount: 50000,
  };

  // Manually set razorpayOrderId so webhook lookup works
  payment.razorpayOrderId = entity.order_id;
  payment.status = 'PROCESSING';
  await payment.save();

  const eventType = 'payment.captured';
  const payload = { event: eventType, payload: { payment: { entity } } };

  // --- First webhook: should PROCESS ---
  payment.status = 'SUCCESS';
  payment.razorpayPaymentId = entity.id;
  payment.logs.push({ timestamp: new Date(), event: 'WEBHOOK_APPLIED', details: 'First webhook → SUCCESS' });
  await payment.save();
  const log1 = await WebhookLog.create({ paymentId: payment._id.toString(), source: 'razorpay', eventType, payload, result: 'PROCESSED' });

  // --- Second webhook: same entity.id + eventType → should IGNORE ---
  const alreadyProcessed = await WebhookLog.findOne({
    eventType,
    'payload.payload.payment.entity.id': entity.id,
    result: 'PROCESSED',
  });

  let secondResult: string;
  if (alreadyProcessed) {
    secondResult = 'IGNORED — duplicate detected via WebhookLog deduplication check';
  } else {
    await WebhookLog.create({ paymentId: payment._id.toString(), source: 'razorpay', eventType, payload, result: 'IGNORED' });
    secondResult = 'IGNORED — logged';
  }

  return res.status(200).json({
    scenario: 'duplicate_callback',
    description: 'Same webhook event fired twice for the same payment',
    paymentId: payment._id,
    firstWebhook: { result: 'PROCESSED', logId: log1._id },
    secondWebhook: { result: secondResult },
  });
});

// ---------------------------------------------------------------------------
// POST /api/simulate/webhook/conflict
// Creates a FAILED payment then fires a payment.captured webhook for it.
// Demonstrates: conflicting state — webhook result is CONFLICT, state not overwritten.
// ---------------------------------------------------------------------------
router.post('/webhook/conflict', async (req: AuthRequest, res: Response) => {
  const idempotencyKey = `sim_wh_conflict_${uuidv4()}`;
  const orderId = `order_conflict_${uuidv4().slice(0, 8)}`;

  const payment = await Payment.create({
    userId: req.userId!,
    amount: 500,
    currency: 'INR',
    status: 'FAILED',   // already in terminal state
    razorpayOrderId: orderId,
    idempotencyKey,
    lastError: 'USER_CANCELLED',
    metadata: { simulated: true, scenario: 'conflict_webhook' },
    logs: [
      { timestamp: new Date(), event: 'SIM_INITIATED', details: 'conflict webhook test' },
      { timestamp: new Date(), event: 'FAILED', details: 'USER_CANCELLED' },
    ],
  });

  // Incoming webhook says payment succeeded — conflicts with FAILED state
  const entity = {
    id: `pay_conflict_${uuidv4().slice(0, 8)}`,
    order_id: orderId,
    status: 'captured',
    amount: 50000,
  };
  const eventType = 'payment.captured';
  const payload = { event: eventType, payload: { payment: { entity } } };

  const statusBefore = payment.status;

  // Conflict logic (mirrors webhook handler)
  const result = 'CONFLICT';
  payment.logs.push({
    timestamp: new Date(),
    event: 'WEBHOOK_IGNORED',
    details: `Already ${payment.status}, incoming: SUCCESS (CONFLICT)`,
  });
  await payment.save();
  await WebhookLog.create({ paymentId: payment._id.toString(), source: 'razorpay', eventType, payload, result });

  return res.status(200).json({
    scenario: 'conflict_callback',
    description: 'Webhook says SUCCESS but payment is already FAILED',
    paymentId: payment._id,
    statusBefore,
    statusAfter: payment.status,
    webhookResult: result,
    explanation: 'State was NOT overwritten. Logged as CONFLICT in WebhookLog.',
  });
});

export default router;
