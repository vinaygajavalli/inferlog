import { z } from "zod";

/**
 * The ingestion boundary is where untrusted input becomes trusted data, so we
 * validate strictly here and nowhere downstream. Anything that fails validation
 * is rejected with the index so the SDK could (in principle) quarantine it.
 */
export const InferenceLogSchema = z.object({
  requestId: z.string().min(1).max(128),
  conversationId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),

  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  streaming: z.boolean(),

  status: z.enum(["success", "error", "cancelled"]),
  errorType: z.string().max(64).optional(),
  errorMessage: z.string().max(2000).optional(),

  latencyMs: z.number().int().nonnegative().optional(),
  ttftMs: z.number().int().nonnegative().optional(),

  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  tokensEstimated: z.boolean().optional(),

  inputPreview: z.string().max(4000).optional(),
  outputPreview: z.string().max(4000).optional(),

  requestedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),

  metadata: z.record(z.unknown()).optional(),
});

export const BatchSchema = z.object({
  logs: z.array(InferenceLogSchema).min(1).max(500),
});

export type ValidatedLog = z.infer<typeof InferenceLogSchema>;
