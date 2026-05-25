import type {
  ChatRequest,
  CompletionResult,
  Provider,
  ProviderName,
} from "../types.js";
import { estimatePromptTokens, estimateTokens } from "../tokens.js";

/**
 * A keyless provider so the entire pipeline — chat → SDK → ingestion → worker →
 * DB → dashboards — is demoable offline with `docker compose up` and nothing
 * else. It streams a deterministic-ish reply token by token with a small delay
 * so latency and TTFT numbers in the dashboard are real, not zero.
 *
 * It also occasionally throws (configurable) so the error-rate panel has
 * something to show.
 */
export class MockProvider implements Provider {
  readonly name: ProviderName = "mock";
  private errorRate: number;
  private delayMs: number;

  constructor(opts: { errorRate?: number; delayMs?: number } = {}) {
    this.errorRate = opts.errorRate ?? 0.05;
    this.delayMs = opts.delayMs ?? 18;
  }

  private reply(req: ChatRequest): string {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const q = lastUser?.content ?? "";
    return (
      `You're talking to the mock provider (no real model is being called). ` +
      `I received ${req.messages.length} message(s) of context. ` +
      `Your last message was: "${q.slice(0, 140)}". ` +
      `Swap in a real provider by setting an API key in .env — the logging ` +
      `pipeline behaves identically either way.`
    );
  }

  private maybeThrow() {
    if (Math.random() < this.errorRate) {
      const err = new Error("mock: simulated upstream failure");
      (err as any).errorType = "provider_5xx";
      throw err;
    }
  }

  async complete(req: ChatRequest): Promise<CompletionResult> {
    this.maybeThrow();
    const text = this.reply(req);
    await sleep(this.delayMs * 6);
    return {
      text,
      finishReason: "stop",
      usage: usageFor(req, text),
    };
  }

  async *stream(
    req: ChatRequest,
  ): AsyncGenerator<string, CompletionResult, void> {
    this.maybeThrow();
    const full = this.reply(req);
    const words = full.split(/(\s+)/); // keep whitespace tokens
    let text = "";
    // a touch of upfront latency so TTFT is non-zero
    await sleep(this.delayMs * 4);
    for (const w of words) {
      if (req.signal?.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      text += w;
      yield w;
      await sleep(this.delayMs);
    }
    return { text, finishReason: "stop", usage: usageFor(req, text) };
  }
}

function usageFor(req: ChatRequest, text: string) {
  const promptTokens = estimatePromptTokens(req.messages);
  const completionTokens = estimateTokens(text);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
