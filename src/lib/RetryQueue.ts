// ---------------------------------------------------------------------------
// Queue-based async retry handler with exponential backoff
// ---------------------------------------------------------------------------

export interface JobOptions {
  maxAttempts?: number;   // default 5
  baseDelayMs?: number;   // default 1000ms
  label?: string;
}

export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface JobRecord {
  id: string;
  label: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  lastAttemptAt?: Date;
  error?: string;
}

interface InternalJob<T> extends JobRecord {
  fn: () => Promise<T>;
  onSuccess: (result: T) => void;
  onFailure: (err: Error) => void;
  baseDelayMs: number;
}

class RetryQueue {
  private queue: InternalJob<any>[] = [];
  private running = false;
  private jobHistory: JobRecord[] = [];
  private readonly historyLimit = 200;

  // Enqueue a job. Returns immediately — processing happens asynchronously.
  enqueue<T>(
    id: string,
    fn: () => Promise<T>,
    onSuccess: (result: T) => void,
    onFailure: (err: Error) => void,
    options: JobOptions = {}
  ): void {
    const job: InternalJob<T> = {
      id,
      fn,
      onSuccess,
      onFailure,
      label: options.label ?? id,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 5,
      baseDelayMs: options.baseDelayMs ?? 1000,
      createdAt: new Date(),
    };

    this.queue.push(job);
    console.log(`[RetryQueue] Enqueued job "${job.label}" (id: ${id})`);
    this.tick();
  }

  // Returns a snapshot of recent job history for monitoring
  getStats() {
    return {
      queued: this.queue.length,
      history: this.jobHistory.slice(-50),
    };
  }

  private tick() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    this.processNext();
  }

  private async processNext() {
    while (this.queue.length > 0) {
      const job = this.queue[0];
      job.status = 'RUNNING';
      job.attempts++;
      job.lastAttemptAt = new Date();

      console.log(`[RetryQueue] Processing "${job.label}" attempt ${job.attempts}/${job.maxAttempts}`);

      try {
        const result = await job.fn();
        job.status = 'SUCCESS';
        this.archiveJob(job);
        this.queue.shift();
        job.onSuccess(result);
        console.log(`[RetryQueue] Job "${job.label}" succeeded on attempt ${job.attempts}`);
      } catch (err: any) {
        job.error = err.message;
        console.warn(`[RetryQueue] Job "${job.label}" attempt ${job.attempts} failed: ${err.message}`);

        if (job.attempts >= job.maxAttempts) {
          // Exhausted all attempts
          job.status = 'FAILED';
          this.archiveJob(job);
          this.queue.shift();
          job.onFailure(new Error(`Job "${job.label}" failed after ${job.attempts} attempts. Last error: ${err.message}`));
          console.error(`[RetryQueue] Job "${job.label}" permanently failed after ${job.attempts} attempts`);
        } else {
          // Exponential backoff: 1s, 2s, 4s, 8s, ...
          const delay = job.baseDelayMs * Math.pow(2, job.attempts - 1);
          job.status = 'PENDING';
          console.log(`[RetryQueue] Retrying "${job.label}" in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    this.running = false;
  }

  private archiveJob(job: InternalJob<any>) {
    const record: JobRecord = {
      id: job.id,
      label: job.label,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt,
      lastAttemptAt: job.lastAttemptAt,
      error: job.error,
    };
    this.jobHistory.push(record);
    if (this.jobHistory.length > this.historyLimit) this.jobHistory.shift();
  }
}

// Singleton — shared across the entire process
export const retryQueue = new RetryQueue();
