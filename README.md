<<<<<<< HEAD
# inferlog

An LLM chatbot with a production-shaped **inference logging and ingestion pipeline** behind it.

Every model call the chatbot makes is wrapped by a small SDK that captures metadata — provider, model, latency, time-to-first-token, token usage, status/errors, session and message IDs, and input/output previews — and ships it, **without blocking the user's response**, to an ingestion service. From there it flows through an event bus to a worker that redacts PII and persists it to Postgres, where a live dashboard reads it back.

```
Browser ──> Next.js chat API ──uses──> Logger SDK ──LLM call──> Provider
                  │                          │
        (sync, transcript)           (async, fire-and-forget)
                  ▼                          ▼
              Postgres                  Ingestion API ──> Redis Stream ──> Worker ──(redact)──> Postgres
                  ▲                                                                                  │
                  └────────────────────── Dashboard reads aggregates ◄──────────────────────────────┘
```

The single most important design decision is that **the chat transcript and the inference logs travel on two different paths** — see [Key tradeoffs](#key-tradeoffs).

---

## Quickstart

**One command, zero API keys:**

```bash
docker compose up --build
```

- Chat UI → http://localhost:3000
- Dashboard → http://localhost:3000/dashboard

With no keys configured the chatbot uses a built-in **mock provider** that streams real token-by-token output with real latency (and a small simulated error rate), so the entire pipeline — streaming, logging, ingestion, redaction, dashboards — is fully demoable offline. Send a few messages, then watch them appear on the dashboard within a couple of seconds.

**To use a real model**, create a `.env` in the repo root:

```bash
cp .env.example .env
# then set ONE of:
ANTHROPIC_API_KEY=sk-ant-...        # uses Anthropic
# or
OPENAI_API_KEY=sk-...               # uses OpenAI
# OpenAI-compatible providers (Groq, DeepSeek, Together, …):
#   OPENAI_API_KEY=...  OPENAI_BASE_URL=https://api.groq.com/openai/v1  PROVIDER_NAME=groq  MODEL=llama-3.3-70b-versatile
```

Nothing else changes — provider selection is pure configuration.

### Supported providers

The chatbot works with **any foundation model API**, and supports **several at once** — pick the provider per message from the dropdown in the chat header, and the dashboard's "by provider" panel shows them side by side. Claude uses a native adapter; everything else runs through one OpenAI-compatible adapter (only base URL + key + model change). The keyless `mock` provider is always available as a second option. `.env.example` has copy-paste presets.

| Model | env key | adapter |
|---|---|---|
| Claude Sonnet | `ANTHROPIC_API_KEY` | native Anthropic |
| GPT-4.1 | `OPENAI_API_KEY_NATIVE` | OpenAI-compatible |
| Gemini | `GEMINI_API_KEY` | OpenAI-compatible |
| DeepSeek | `DEEPSEEK_API_KEY` | OpenAI-compatible |
| Grok (xAI) | `XAI_API_KEY` | OpenAI-compatible |
| Groq | `GROQ_API_KEY` | OpenAI-compatible |

Set as many keys as you have; each becomes selectable. (A generic `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `PROVIDER_NAME` slot also works for any OpenAI-compatible endpoint.) Internally each configured provider gets its own logger sharing one log transport, so adding a provider is config, not code.

> The **mock** provider (always present) is a keyless fallback for review-without-secrets and a deterministic test seam — it is *not* a foundation model. Set a real key for the demo.

### Local dev (without Docker)

```bash
pnpm install
pnpm build:sdk                       # the SDK is a workspace dependency of web
# bring up Postgres + Redis however you like, apply db/schema.sql, then:
pnpm dev:ingestion                   # :4000
pnpm dev:worker
pnpm dev:web                         # :3000
```

---

## Project structure

```
packages/inference-logger   # the logging SDK (provider wrappers + non-blocking transport)
apps/web                    # Next.js chat UI + dashboards + chat/conversation/metrics APIs
apps/ingestion              # Fastify service: validate → publish to the event bus
apps/worker                 # Redis Stream consumer: redact PII → persist to Postgres
db/schema.sql               # Postgres schema (applied automatically on first boot)
k8s/                        # self-hosted Kubernetes manifests
```

---

## Database design

Three tables; the split mirrors the two-path architecture. Full DDL with commentary is in [`db/schema.sql`](db/schema.sql).

- **`conversations`** — one row per session (`active` | `cancelled`, title, last model/provider). Written synchronously by the chat app.
- **`messages`** — the transcript (`system`/`user`/`assistant`). Also synchronous. A trigger bumps `conversations.updated_at` on insert so the sidebar can order by recency cheaply.
- **`inference_logs`** — one row per LLM call, written **only** by the worker.

Decisions worth calling out:

- **`request_id` is `UNIQUE`.** The queue is at-least-once, so a log can arrive twice; the worker inserts with `ON CONFLICT (request_id) DO NOTHING`, making redelivery a no-op. Idempotency lives in the schema, not in fragile application logic.
- **`conversation_id` / `message_id` on `inference_logs` are soft links** (no foreign key). Logs are observability data and must survive even if a conversation is purged, and ingestion should never block on a referential check against a table it doesn't own.
- **Latency timestamps come from the SDK**, not the DB. `requested_at`/`completed_at` are measured at the call site; `ingested_at` is separate so you can see pipeline lag.
- **`tokens_estimated` flag.** Some streaming endpoints don't return usage, so the SDK falls back to a local tokenizer and marks the row honestly rather than silently reporting fake-precise numbers.
- **Indexes follow the dashboard's query patterns** — time-range scans, `(provider, model)` grouping, a partial index on errors, and a GIN index on the `metadata` JSONB escape hatch.

---

## Key tradeoffs

**Transcript vs. logs travel on different paths — on purpose.**
Persisting a user/assistant message is part of the product: if it's lost, "resume conversation" breaks. So messages are **synchronous, reliable DB writes** owned by the chat app. An inference *log* is observability: dropping one metric is acceptable, but adding latency to (or failing) a user's reply to record a metric is not. So logs are **fire-and-forget** through a bounded in-memory buffer → ingestion → queue → worker. If ingestion or the worker is down, **chat keeps working**; logs queue and catch up.

**At-least-once + idempotency over exactly-once.** Exactly-once across a network is expensive and usually a myth. Cheaper and more robust: deliver at-least-once (retry batches, durable Redis Stream, consumer-group acks only after a durable write) and dedupe on `request_id`.

**TTFT is logged separately from total latency.** For streaming UX, time-to-first-token is the number users actually feel; total latency hides it. Both are captured.

**Bounded buffer with drop-oldest.** If ingestion stays down, the SDK's buffer caps memory and drops oldest-first (surfaced via an `onDrop` hook) rather than risking OOM in the chat process. Back-pressure is a deliberate, observable choice.

**A mock provider is a first-class provider.** It makes the system reviewable with `docker compose up` and nothing else, and doubles as a deterministic test seam.

---

## Bonus items implemented

- ✅ **Multi-provider** — Anthropic, OpenAI, and any OpenAI-compatible API (Groq/DeepSeek/Together/…) via the same adapter; selection is config-only.
- ✅ **Streaming** — SSE end to end, with TTFT measured and logged.
- ✅ **Dashboards** — throughput, error rate, p50/p95/p99 latency, TTFT, token usage, per-provider/model breakdown, live recent-inference feed.
- ✅ **One-command Docker Compose** with the schema auto-applied and a keyless demo path.
- ✅ **Event-based architecture** — Redis Streams as a durable bus with consumer groups.
- ✅ **PII redaction** — applied in the worker before previews are stored, with a `pii_redacted` audit flag.
- ✅ **Self-hosted Kubernetes** manifests in [`k8s/`](k8s/).
- ✅ **Frontend** — list, resume, and cancel conversations; stop an in-flight stream.

---

## Future improvements

- **Swap Redis Streams for Kafka/NATS** at higher volume — the producer/consumer split is already shaped for it.
- **Replace regex PII redaction with a real detector** (Presidio or a NER model) behind the same `redact()` interface; nothing upstream changes.
- **Authentication + multi-tenant scoping** (org/user IDs already fit naturally on the log envelope and `metadata`).
- **Cost tracking** — multiply token usage by per-model pricing for a spend dashboard.
- **Sampling / retention tiers** for logs at scale (keep 100% of errors, sample successes).
- **OpenTelemetry traces** linking the chat request span to the ingestion + persistence spans.
- **Tests** — the mock provider and the `redact()`/transport units are the obvious first targets.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the ingestion flow, logging strategy, scaling, and failure-handling detail.
=======
# inferlog
>>>>>>> 3c8c3508926b934b5512728c01b1c2bc56a0d6c3
