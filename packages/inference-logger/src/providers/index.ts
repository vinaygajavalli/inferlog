import type { Provider } from "../types.js";
import { OpenAICompatProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";

export { OpenAICompatProvider } from "./openai.js";
export { AnthropicProvider } from "./anthropic.js";
export { MockProvider } from "./mock.js";

/**
 * Resolve a provider from environment variables. Order of preference:
 *   ANTHROPIC_API_KEY  -> Anthropic
 *   OPENAI_API_KEY     -> OpenAI (or any OpenAI-compatible base via OPENAI_BASE_URL + PROVIDER_NAME)
 *   (none)             -> Mock, so the demo always runs.
 *
 * This keeps provider selection a config concern, which is the whole point of
 * "multi-provider support".
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): {
  provider: Provider;
  defaultModel: string;
} {
  if (env.ANTHROPIC_API_KEY) {
    return {
      provider: new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }),
      defaultModel: env.MODEL ?? "claude-sonnet-4-20250514",
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      provider: new OpenAICompatProvider({
        apiKey: env.OPENAI_API_KEY,
        baseURL: env.OPENAI_BASE_URL,
        name: env.PROVIDER_NAME ?? "openai",
      }),
      defaultModel: env.MODEL ?? "gpt-4.1-mini",
    };
  }
  return { provider: new MockProvider(), defaultModel: "mock-1" };
}
