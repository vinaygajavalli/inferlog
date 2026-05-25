import type {
  ChatRequest,
  CompletionResult,
  Provider,
  ProviderName,
} from "../types.js";
import { sseLines } from "./openai.js";

export interface AnthropicConfig {
  apiKey: string;
  baseURL?: string;
  name?: ProviderName;
}

/**
 * Anthropic Messages API. Anthropic splits the system prompt out of the
 * messages array and reports usage incrementally across stream events, so the
 * adapter normalises both back to our common Provider shape.
 */
export class AnthropicProvider implements Provider {
  readonly name: ProviderName;
  private apiKey: string;
  private baseURL: string;

  constructor(cfg: AnthropicConfig) {
    this.apiKey = cfg.apiKey;
    this.baseURL = (cfg.baseURL ?? "https://api.anthropic.com/v1").replace(
      /\/$/,
      "",
    );
    this.name = cfg.name ?? "anthropic";
  }

  private headers() {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  private split(req: ChatRequest) {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    return { system: system || undefined, messages };
  }

  async complete(req: ChatRequest): Promise<CompletionResult> {
    const { system, messages } = this.split(req);
    const res = await fetch(`${this.baseURL}/messages`, {
      method: "POST",
      headers: this.headers(),
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        system,
        messages,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature,
      }),
    });
    if (!res.ok) throw await toErr(res);
    const json: any = await res.json();
    return {
      text: json.content?.map((b: any) => b.text ?? "").join("") ?? "",
      finishReason: json.stop_reason,
      usage: {
        promptTokens: json.usage?.input_tokens,
        completionTokens: json.usage?.output_tokens,
        totalTokens:
          (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
      },
      raw: json,
    };
  }

  async *stream(
    req: ChatRequest,
  ): AsyncGenerator<string, CompletionResult, void> {
    const { system, messages } = this.split(req);
    const res = await fetch(`${this.baseURL}/messages`, {
      method: "POST",
      headers: this.headers(),
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        system,
        messages,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) throw await toErr(res);

    let text = "";
    let finishReason: string | undefined;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for await (const data of sseLines(res.body)) {
      let evt: any;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      switch (evt.type) {
        case "message_start":
          usage.promptTokens = evt.message?.usage?.input_tokens ?? 0;
          break;
        case "content_block_delta":
          if (evt.delta?.text) {
            text += evt.delta.text;
            yield evt.delta.text;
          }
          break;
        case "message_delta":
          if (evt.usage?.output_tokens != null)
            usage.completionTokens = evt.usage.output_tokens;
          if (evt.delta?.stop_reason) finishReason = evt.delta.stop_reason;
          break;
      }
    }
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
    return { text, finishReason, usage, raw: undefined };
  }
}

async function toErr(res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  const err = new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`);
  (err as any).status = res.status;
  (err as any).errorType =
    res.status === 429
      ? "rate_limit"
      : res.status >= 500
        ? "provider_5xx"
        : "provider_4xx";
  return err;
}
