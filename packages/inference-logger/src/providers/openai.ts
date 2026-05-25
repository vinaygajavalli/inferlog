import type {
  ChatRequest,
  CompletionResult,
  Provider,
  ProviderName,
} from "../types.js";

export interface OpenAICompatConfig {
  apiKey: string;
  baseURL?: string; // default OpenAI; override for Groq/DeepSeek/Together/etc.
  /** label that shows up in dashboards, e.g. "openai", "groq", "deepseek" */
  name?: ProviderName;
}

/**
 * Adapter for any OpenAI-Chat-Completions-compatible endpoint. The same code
 * path serves OpenAI, Groq, DeepSeek, Together, Fireworks, etc. — only baseURL
 * and the reported `name` change. This is the "multi-provider" lever: add a
 * provider by adding config, not code.
 */
export class OpenAICompatProvider implements Provider {
  readonly name: ProviderName;
  private apiKey: string;
  private baseURL: string;

  constructor(cfg: OpenAICompatConfig) {
    this.apiKey = cfg.apiKey;
    this.baseURL = (cfg.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.name = cfg.name ?? "openai";
  }

  private headers() {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  async complete(req: ChatRequest): Promise<CompletionResult> {
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        stream: false,
      }),
    });
    if (!res.ok) throw await toProviderError(res);
    const json: any = await res.json();
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      finishReason: json.choices?.[0]?.finish_reason,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
      },
      raw: json,
    };
  }

  async *stream(
    req: ChatRequest,
  ): AsyncGenerator<string, CompletionResult, void> {
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        stream: true,
        stream_options: { include_usage: true }, // ask OpenAI for usage in the stream
      }),
    });
    if (!res.ok || !res.body) throw await toProviderError(res);

    let text = "";
    let finishReason: string | undefined;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for await (const data of sseLines(res.body)) {
      if (data === "[DONE]") break;
      let evt: any;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = evt.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        yield delta;
      }
      if (evt.choices?.[0]?.finish_reason) {
        finishReason = evt.choices[0].finish_reason;
      }
      if (evt.usage) {
        usage.promptTokens = evt.usage.prompt_tokens ?? usage.promptTokens;
        usage.completionTokens =
          evt.usage.completion_tokens ?? usage.completionTokens;
        usage.totalTokens = evt.usage.total_tokens ?? usage.totalTokens;
      }
    }

    return { text, finishReason, usage, raw: undefined };
  }
}

async function toProviderError(res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  const err = new Error(`provider ${res.status}: ${body.slice(0, 300)}`);
  (err as any).status = res.status;
  (err as any).errorType =
    res.status === 429
      ? "rate_limit"
      : res.status >= 500
        ? "provider_5xx"
        : "provider_4xx";
  return err;
}

/** Parse an SSE byte stream into `data:` payloads. */
export async function* sseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        yield trimmed.slice(5).trim();
      }
    }
  }
}
