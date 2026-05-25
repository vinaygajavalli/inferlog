import type { InferenceLog, TransportOptions } from "./types.js";

/**
 * Non-blocking log shipper. The chat request path NEVER awaits this — logs are
 * pushed into an in-memory ring buffer and flushed on an interval (or when the
 * buffer fills). Design choices, all deliberate tradeoffs:
 *
 *  - Fire-and-forget: observability must never add latency to, or fail, a user
 *    response. If ingestion is down, the chat still works.
 *  - Bounded buffer with drop-oldest: if ingestion stays down we bound memory
 *    rather than OOM the chat process. Drops are surfaced via onDrop.
 *  - Batched flush: amortises HTTP overhead.
 *  - At-least-once: batches are retried; each log carries a requestId so the
 *    ingestion side can dedupe (UNIQUE constraint in Postgres).
 *
 * In a larger system the HTTP hop would be replaced by a local agent / direct
 * queue producer, but the SDK contract stays the same.
 */
export class LogTransport {
  private buffer: InferenceLog[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly endpoint: string;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxBufferSize: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onDrop?: TransportOptions["onDrop"];

  constructor(opts: TransportOptions) {
    this.endpoint = opts.endpoint;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
    this.batchSize = opts.batchSize ?? 50;
    this.maxBufferSize = opts.maxBufferSize ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onDrop = opts.onDrop;
    this.start();
  }

  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    // don't keep the event loop alive just for the flush timer
    (this.timer as any).unref?.();
  }

  enqueue(log: InferenceLog) {
    if (this.buffer.length >= this.maxBufferSize) {
      const dropped = this.buffer.splice(0, Math.ceil(this.maxBufferSize * 0.1));
      this.onDrop?.(dropped.length, "buffer_full");
    }
    this.buffer.push(log);
    if (this.buffer.length >= this.batchSize) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.batchSize);
    try {
      await this.send(batch);
    } catch {
      // put the batch back at the front; it'll retry on the next tick
      this.buffer.unshift(...batch);
    } finally {
      this.flushing = false;
    }
  }

  private async send(batch: InferenceLog[]): Promise<void> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.maxRetries) {
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ logs: batch }),
        });
        if (res.ok) return;
        // 4xx (other than 429) won't get better on retry — drop to avoid a poison batch
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.onDrop?.(batch.length, `ingestion_${res.status}`);
          return;
        }
        lastErr = new Error(`ingestion ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
      attempt++;
      await sleep(Math.min(2 ** attempt * 100, 2000)); // capped backoff
    }
    throw lastErr;
  }

  /** flush remaining logs; call before process exit */
  async drain(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.buffer.length > 0) {
      const before = this.buffer.length;
      await this.flush();
      if (this.buffer.length >= before) break; // ingestion unreachable; give up
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
