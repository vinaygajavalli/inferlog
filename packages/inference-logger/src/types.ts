// Public types shared across the SDK and (by shape) the ingestion payload.

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export type ProviderName = "openai" | "anthropic" | "mock" | (string & {});

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** true when usage was estimated locally because the provider didn't report it */
  estimated?: boolean;
}

/** What a provider returns for a single completion (streaming or not). */
export interface CompletionResult {
  text: string;
  usage: TokenUsage;
  /** provider-native finish reason, if any */
  finishReason?: string;
  raw?: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  /** propagated abort signal so a cancelled conversation actually stops the upstream call */
  signal?: AbortSignal;
}

export interface Provider {
  readonly name: ProviderName;
  /** non-streaming completion */
  complete(req: ChatRequest): Promise<CompletionResult>;
  /** streaming completion; yields text deltas, returns final usage */
  stream(req: ChatRequest): AsyncGenerator<string, CompletionResult, void>;
}

/**
 * The log envelope shipped to the ingestion endpoint. Mirrors the columns in
 * inference_logs; the ingestion service validates this shape with zod.
 */
export interface InferenceLog {
  requestId: string;
  conversationId?: string;
  messageId?: string;

  provider: ProviderName;
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

  requestedAt: string; // ISO
  completedAt?: string; // ISO

  metadata?: Record<string, unknown>;
}

export interface TransportOptions {
  /** ingestion endpoint, e.g. http://ingestion:4000/v1/logs */
  endpoint: string;
  /** flush the buffer at least this often (ms) */
  flushIntervalMs?: number;
  /** max logs per flush batch */
  batchSize?: number;
  /** max logs to hold in memory before dropping oldest (back-pressure guard) */
  maxBufferSize?: number;
  /** retries per batch before giving up */
  maxRetries?: number;
  /** fetch impl override (testing) */
  fetchImpl?: typeof fetch;
  /** called when logs are dropped, for visibility */
  onDrop?: (count: number, reason: string) => void;
}
