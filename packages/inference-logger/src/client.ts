import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  CompletionResult,
  InferenceLog,
  Provider,
  TransportOptions,
} from "./types.js";
import { LogTransport } from "./transport.js";
import { estimatePromptTokens, estimateTokens } from "./tokens.js";

const PREVIEW_LEN = 500;

export interface LoggerOptions {
  provider: Provider;
  /** transport options (each logger makes its own) or a shared LogTransport */
  transport: TransportOptions | LogTransport;
  /** chars kept from input/output for previews (PII redaction happens server-side) */
  previewLength?: number;
}

export interface CallOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** join keys carried into the log so it can be tied back to the transcript */
  conversationId?: string;
  messageId?: string;
  /** anything extra you want on the log row's metadata JSONB */
  metadata?: Record<string, unknown>;
}

/**
 * The thing application code holds. It wraps a Provider, measures every call,
 * and emits an InferenceLog regardless of success/error/cancellation — then
 * hands it to the (non-blocking) transport.
 */
export class InferenceLogger {
  private provider: Provider;
  private transport: LogTransport;
  private previewLength: number;

  constructor(opts: LoggerOptions) {
    this.provider = opts.provider;
    this.transport =
      opts.transport instanceof LogTransport
        ? opts.transport
        : new LogTransport(opts.transport);
    this.previewLength = opts.previewLength ?? PREVIEW_LEN;
  }

  /** non-streaming call */
  async complete(opts: CallOptions): Promise<CompletionResult> {
    const ctx = this.begin(opts, false);
    try {
      const result = await this.provider.complete({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
      });
      this.finishOk(ctx, opts, result.text, result, undefined);
      return result;
    } catch (err) {
      this.finishErr(ctx, opts, err);
      throw err;
    }
  }

  /**
   * Streaming call. Returns an async iterator of text deltas. Latency, TTFT,
   * usage and final status are logged when the stream ends (or aborts/errors).
   */
  async *stream(opts: CallOptions): AsyncGenerator<string, void, void> {
    const ctx = this.begin(opts, true);
    let acc = "";
    let final: CompletionResult | undefined;
    try {
      const gen = this.provider.stream({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
      });
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          final = value as CompletionResult;
          break;
        }
        if (ctx.ttftMs === undefined) ctx.ttftMs = Date.now() - ctx.startedAt;
        acc += value;
        yield value as string;
      }
      this.finishOk(ctx, opts, acc, final, ctx.ttftMs);
    } catch (err) {
      if (isAbort(err)) this.finishCancelled(ctx, opts, acc);
      else this.finishErr(ctx, opts, err);
      throw err;
    }
  }

  async shutdown() {
    await this.transport.drain();
  }

  // --- internals -----------------------------------------------------------

  private begin(opts: CallOptions, streaming: boolean) {
    return {
      requestId: randomUUID(),
      startedAt: Date.now(),
      requestedAt: new Date().toISOString(),
      streaming,
      ttftMs: undefined as number | undefined,
    };
  }

  private inputPreview(messages: ChatMessage[]): string {
    const last = [...messages].reverse().find((m) => m.role === "user");
    return (last?.content ?? "").slice(0, this.previewLength);
  }

  private emit(log: InferenceLog) {
    this.transport.enqueue(log);
  }

  private finishOk(
    ctx: ReturnType<InferenceLogger["begin"]>,
    opts: CallOptions,
    output: string,
    result: CompletionResult | undefined,
    ttftMs: number | undefined,
  ) {
    const usage = result?.usage ?? {};
    const promptTokens =
      usage.promptTokens ?? estimatePromptTokens(opts.messages);
    const completionTokens =
      usage.completionTokens ?? estimateTokens(output);
    const estimated =
      usage.estimated ??
      (result?.usage?.promptTokens == null ||
        result?.usage?.completionTokens == null);

    this.emit({
      requestId: ctx.requestId,
      conversationId: opts.conversationId,
      messageId: opts.messageId,
      provider: this.provider.name,
      model: opts.model,
      streaming: ctx.streaming,
      status: "success",
      latencyMs: Date.now() - ctx.startedAt,
      ttftMs,
      promptTokens,
      completionTokens,
      totalTokens:
        usage.totalTokens ?? promptTokens + completionTokens,
      tokensEstimated: estimated,
      inputPreview: this.inputPreview(opts.messages),
      outputPreview: output.slice(0, this.previewLength),
      requestedAt: ctx.requestedAt,
      completedAt: new Date().toISOString(),
      metadata: {
        ...opts.metadata,
        finishReason: result?.finishReason,
      },
    });
  }

  private finishErr(
    ctx: ReturnType<InferenceLogger["begin"]>,
    opts: CallOptions,
    err: unknown,
  ) {
    const e = err as any;
    this.emit({
      requestId: ctx.requestId,
      conversationId: opts.conversationId,
      messageId: opts.messageId,
      provider: this.provider.name,
      model: opts.model,
      streaming: ctx.streaming,
      status: "error",
      errorType: e?.errorType ?? "unknown",
      errorMessage: String(e?.message ?? err).slice(0, 500),
      latencyMs: Date.now() - ctx.startedAt,
      ttftMs: ctx.ttftMs,
      inputPreview: this.inputPreview(opts.messages),
      requestedAt: ctx.requestedAt,
      completedAt: new Date().toISOString(),
      metadata: { ...opts.metadata, status: e?.status },
    });
  }

  private finishCancelled(
    ctx: ReturnType<InferenceLogger["begin"]>,
    opts: CallOptions,
    partial: string,
  ) {
    this.emit({
      requestId: ctx.requestId,
      conversationId: opts.conversationId,
      messageId: opts.messageId,
      provider: this.provider.name,
      model: opts.model,
      streaming: ctx.streaming,
      status: "cancelled",
      latencyMs: Date.now() - ctx.startedAt,
      ttftMs: ctx.ttftMs,
      completionTokens: estimateTokens(partial),
      tokensEstimated: true,
      inputPreview: this.inputPreview(opts.messages),
      outputPreview: partial.slice(0, this.previewLength),
      requestedAt: ctx.requestedAt,
      completedAt: new Date().toISOString(),
      metadata: { ...opts.metadata, partial: true },
    });
  }
}

function isAbort(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    ((err as any).name === "AbortError" ||
      (err as any).code === "ABORT_ERR")
  );
}
