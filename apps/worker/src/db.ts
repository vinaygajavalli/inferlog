import pg from "pg";

const { Pool } = pg;

export function makePool(connectionString: string) {
  return new Pool({ connectionString, max: 8 });
}

export interface LogRow {
  requestId: string;
  conversationId?: string;
  messageId?: string;
  provider: string;
  model: string;
  streaming: boolean;
  status: "success" | "error" | "cancelled";
  errorType?: string;
  errorMessage?: string;
  latencyMs?: number;
  ttftMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  tokensEstimated?: boolean;
  inputPreview?: string;
  outputPreview?: string;
  piiRedacted: boolean;
  requestedAt: string;
  completedAt?: string;
  metadata: Record<string, unknown>;
}

/**
 * Insert one log. ON CONFLICT (request_id) DO NOTHING gives us idempotency:
 * the queue is at-least-once, so the same log may arrive twice; the UNIQUE
 * constraint + this clause make a duplicate a no-op.
 */
export async function insertLog(pool: pg.Pool, r: LogRow): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO inference_logs (
       request_id, conversation_id, message_id,
       provider, model, streaming,
       status, error_type, error_message,
       latency_ms, ttft_ms,
       prompt_tokens, completion_tokens, total_tokens, tokens_estimated,
       input_preview, output_preview, pii_redacted,
       requested_at, completed_at, metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
     )
     ON CONFLICT (request_id) DO NOTHING`,
    [
      r.requestId,
      r.conversationId ?? null,
      r.messageId ?? null,
      r.provider,
      r.model,
      r.streaming,
      r.status,
      r.errorType ?? null,
      r.errorMessage ?? null,
      r.latencyMs ?? null,
      r.ttftMs ?? null,
      r.promptTokens ?? null,
      r.completionTokens ?? null,
      r.totalTokens ?? null,
      r.tokensEstimated ?? false,
      r.inputPreview ?? null,
      r.outputPreview ?? null,
      r.piiRedacted,
      r.requestedAt,
      r.completedAt ?? null,
      JSON.stringify(r.metadata ?? {}),
    ],
  );
  return (res.rowCount ?? 0) > 0;
}
