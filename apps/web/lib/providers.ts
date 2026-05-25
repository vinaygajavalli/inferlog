import {
  InferenceLogger,
  LogTransport,
  AnthropicProvider,
  OpenAICompatProvider,
  MockProvider,
  type Provider,
} from "@inferlog/logger";

export interface RegistryEntry {
  name: string; // dashboard label, e.g. "gemini"
  model: string; // default model for this provider
  logger: InferenceLogger;
}

export interface ProviderInfo {
  name: string;
  model: string;
}

// Known OpenAI-compatible providers: base URL is baked in, you just add a key.
// Each can be overridden with <NAME>_MODEL.
const OPENAI_COMPAT: Record<
  string,
  { envKey: string; baseURL: string; defaultModel: string }
> = {
  openai: {
    envKey: "OPENAI_API_KEY_NATIVE",
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
  },
  gemini: {
    envKey: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
  },
  groq: {
    envKey: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
  },
  deepseek: {
    envKey: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
  },
  grok: {
    envKey: "XAI_API_KEY",
    baseURL: "https://api.x.ai/v1",
    defaultModel: "grok-2-latest",
  },
};

const g = globalThis as unknown as {
  __registry?: {
    entries: Map<string, RegistryEntry>;
    transport: LogTransport;
    defaultName: string;
  };
};

function build() {
  const env = process.env;
  const transport = new LogTransport({
    endpoint: env.INGESTION_URL ?? "http://localhost:4000/v1/logs",
    flushIntervalMs: 750,
    onDrop: (n, reason) => console.warn(`[inferlog] dropped ${n} logs (${reason})`),
  });

  const entries = new Map<string, RegistryEntry>();
  const add = (name: string, provider: Provider, model: string) => {
    if (entries.has(name)) return;
    entries.set(name, {
      name,
      model,
      logger: new InferenceLogger({ provider, transport }),
    });
  };

  // 1) Anthropic (native)
  if (env.ANTHROPIC_API_KEY) {
    add(
      "anthropic",
      new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }),
      env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
    );
  }

  // 2) Legacy single-provider path: OPENAI_API_KEY (+ OPENAI_BASE_URL + PROVIDER_NAME).
  //    Keeps existing .env files working (e.g. Gemini via the OpenAI-compatible base).
  if (env.OPENAI_API_KEY) {
    const name = env.PROVIDER_NAME || "openai";
    add(
      name,
      new OpenAICompatProvider({
        apiKey: env.OPENAI_API_KEY,
        baseURL: env.OPENAI_BASE_URL,
        name,
      }),
      env.MODEL || OPENAI_COMPAT[name]?.defaultModel || "gpt-4.1-mini",
    );
  }

  // 3) Explicit per-provider keys (lets you run several at once).
  for (const [name, cfg] of Object.entries(OPENAI_COMPAT)) {
    const key = env[cfg.envKey];
    if (!key) continue;
    add(
      name,
      new OpenAICompatProvider({ apiKey: key, baseURL: cfg.baseURL, name }),
      env[`${name.toUpperCase()}_MODEL`] || cfg.defaultModel,
    );
  }

  // 4) Mock is always available (keyless demo + a second provider for the breakdown).
  add("mock", new MockProvider(), "mock-1");

  const defaultName =
    [...entries.keys()].find((n) => n !== "mock") ?? "mock";

  return { entries, transport, defaultName };
}

export function registry() {
  if (!g.__registry) g.__registry = build();
  return g.__registry;
}

/** Resolve a provider by name; falls back to the default, then mock. */
export function resolveProvider(name?: string): RegistryEntry {
  const r = registry();
  return (
    (name && r.entries.get(name)) ||
    r.entries.get(r.defaultName) ||
    r.entries.get("mock")!
  );
}

/** List for the UI dropdown. */
export function listProviders(): { providers: ProviderInfo[]; default: string } {
  const r = registry();
  return {
    providers: [...r.entries.values()].map((e) => ({
      name: e.name,
      model: e.model,
    })),
    default: r.defaultName,
  };
}
