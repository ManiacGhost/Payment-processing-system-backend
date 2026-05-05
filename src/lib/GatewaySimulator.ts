// ---------------------------------------------------------------------------
// External Gateway Simulator
// Simulates a real payment provider with random success, failure, delays,
// timeouts, and network errors — for demonstration and testing purposes.
// ---------------------------------------------------------------------------

export type SimulationScenario =
  | 'success'
  | 'failure'
  | 'timeout'
  | 'network_error'
  | 'partial_failure'   // succeeds after 1-2 retries
  | 'random';           // one of the above chosen randomly

export interface GatewayRequest {
  paymentId: string;
  amount: number;
  currency: string;
  scenario?: SimulationScenario;
}

export interface GatewayResponse {
  gatewayTransactionId: string;
  status: 'SUCCESS' | 'FAILED';
  scenario: string;
  delayMs: number;
  attempts: number;
  message: string;
}

// Weighted random scenario picker: 60% success, 20% failure, 10% timeout, 10% network_error
function pickRandomScenario(): SimulationScenario {
  const roll = Math.random();
  if (roll < 0.60) return 'success';
  if (roll < 0.80) return 'failure';
  if (roll < 0.90) return 'timeout';
  return 'network_error';
}

// Simulate realistic gateway latency (100ms–800ms)
function randomDelay(min = 100, max = 800): Promise<number> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(() => resolve(ms), ms));
}

let partialFailureAttempts = new Map<string, number>();

export async function simulateGateway(req: GatewayRequest): Promise<GatewayResponse> {
  const scenario = req.scenario === 'random' || !req.scenario
    ? pickRandomScenario()
    : req.scenario;

  const txnId = `sim_txn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  switch (scenario) {
    case 'success': {
      const delay = await randomDelay(100, 600);
      return {
        gatewayTransactionId: txnId,
        status: 'SUCCESS',
        scenario,
        delayMs: delay,
        attempts: 1,
        message: 'Payment processed successfully',
      };
    }

    case 'failure': {
      const delay = await randomDelay(100, 400);
      throw Object.assign(new Error('Gateway declined the transaction'), {
        code: 'GATEWAY_DECLINED',
        scenario,
        delayMs: delay,
      });
    }

    case 'timeout': {
      // Simulate a gateway that hangs for 11 seconds — beyond typical 10s timeout
      await new Promise(resolve => setTimeout(resolve, 11000));
      throw Object.assign(new Error('Gateway request timed out'), {
        code: 'GATEWAY_TIMEOUT',
        scenario,
        delayMs: 11000,
      });
    }

    case 'network_error': {
      const delay = await randomDelay(50, 200);
      throw Object.assign(new Error('Network error — connection refused'), {
        code: 'NETWORK_ERROR',
        scenario,
        delayMs: delay,
      });
    }

    case 'partial_failure': {
      // Fails first 2 attempts, succeeds on 3rd — demonstrates retry logic
      const attempts = (partialFailureAttempts.get(req.paymentId) || 0) + 1;
      partialFailureAttempts.set(req.paymentId, attempts);

      if (attempts < 3) {
        const delay = await randomDelay(100, 300);
        throw Object.assign(new Error(`Transient failure (attempt ${attempts}/3)`), {
          code: 'TRANSIENT_ERROR',
          scenario,
          delayMs: delay,
        });
      }

      // Clean up tracking after success
      partialFailureAttempts.delete(req.paymentId);
      const delay = await randomDelay(100, 400);
      return {
        gatewayTransactionId: txnId,
        status: 'SUCCESS',
        scenario,
        delayMs: delay,
        attempts,
        message: `Payment succeeded after ${attempts} attempts`,
      };
    }

    default:
      throw new Error(`Unknown scenario: ${scenario}`);
  }
}
