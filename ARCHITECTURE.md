# Architecture

## Components

| Component | Tech | Responsibility |
|---|---|---|
| `apps/web` | Next.js 14 (App Router) | Chat UI + dashboards; chat API route owns the transcript and drives the SDK |
| `packages/inference-logger` | TypeScript | Wraps provider calls, measures them, ships logs non-blockingly |
| `apps/ingestion` | Fastify | Validates incoming logs, publishes them to the event bus |
| `apps/worker` | Node | Consumes the bus, redacts PII, persists to Postgres |
| Redis | Streams | Durable event bus between ingestion and persistence |
| Postgres | — | Transcript + inference logs |

## The two paths (why this shape)

A chat turn does two unrelated things, with different reliability requirements:

1. **Record the transcript** so the conversation can be resumed. Losing this breaks the product → it must be a synchronous, durable write. The chat API route writes `messages`/`conversations` to Postgres directly, before and after the model call.

2. **Record an inference log** for observability. Losing one is acceptable; making the user wait for it is not. This goes through the SDK's fire-and-forget transport → ingestion → queue → worker.

Keeping these separate means an outage in the logging pipeline has **zero impact on chat**, and the two can be scaled and reasoned about independently.

## Inference flow (the logging path)

1. **Call site.** The chat route calls `logger.stream({ model, messages, conversationId, signal, metadata })`. The SDK starts a timer and a `requestId` (a UUID, used later for idempotency).
2. **Provider call.** The SDK's provider adapter streams from the upstream API. The first received token sets `ttftMs`; deltas are yielded straight back to the route, which forwards them to the browser as SSE. No logging work happens on this hot path.
3. **Finalize.** When the stream ends (or errors, or is aborted), the SDK assembles an `InferenceLog` — status (`success`/`error`/`cancelled`), total latency, TTFT, token usage (provider-reported or estimated and flagged), and truncated input/output previews — and hands it to the transport.
4. **Transport.** Logs go into a bounded in-memory ring buffer and are flushed on an interval or when a batch fills, as a single `POST /v1/logs` to the ingestion service. Failures are retried with capped backoff; the buffer drops oldest-first if it saturates.
5. **Ingestion.** Fastify validates the batch with a zod schema (the trust boundary), then `XADD`s each log onto the `inferlog:logs` Redis Stream and returns `202 Accepted`. It does **not** touch Postgres — accept-then-process keeps a slow DB from back-pressuring the chat app, and lets ingestion and storage scale separately. If the bus is unavailable it returns `503` so the SDK retries.
6. **Worker.** A consumer in the `ingest-workers` group does a blocking `XREADGROUP`, redacts PII in the previews, and inserts into `inference_logs` with `ON CONFLICT (request_id) DO NOTHING`. It `XACK`s **only after** the durable write. A periodic `XAUTOCLAIM` reclaims entries left pending by a crashed consumer.
7. **Read path.** The dashboard's `/api/metrics` runs SQL aggregates (percentiles, per-minute buckets, provider breakdown) over `inference_logs` and polls every few seconds.

## Logging strategy

- **What's captured:** provider, model, streaming flag, status, error type/message, total latency, TTFT, prompt/completion/total tokens (+ an `estimated` flag), input/output previews, `requestedAt`/`completedAt`, plus `conversationId`/`messageId` join keys and a free-form `metadata` object.
- **Non-blocking by construction:** the request path never `await`s a log write. The worst case for the user is that a log is delayed or dropped, never that their reply is.
- **Previews, not payloads:** only truncated previews are stored, and they're PII-redacted before they land. Full prompts/completions are intentionally *not* persisted in the log store.
- **Honest token accounting:** provider usage is used when available; otherwise a local tokenizer estimate is stored and marked `tokens_estimated = true`.

## Scaling

- **Chat (`web`)** — stateless; scale horizontally behind a load balancer. The DB pool is per-process.
- **Ingestion** — stateless HTTP; scale horizontally. The Redis `XADD` is the only dependency.
- **Worker** — scale by adding replicas to the consumer group; Redis partitions pending entries across consumers so each log is processed once. This is the main throughput lever for the write path.
- **Postgres** — first reach for read replicas (the dashboard is read-heavy) and time-based partitioning of `inference_logs` (e.g. monthly) with a retention policy. The indexes are already aligned to the dashboard's access patterns.
- **Bus** — Redis Streams comfortably handles a single-node workload. Beyond that, migrate to Kafka/NATS; the produce/consume boundary is deliberately thin so this is a localized change.

Rough capacity intuition: the expensive part of a chat turn is the model call (hundreds of ms to seconds). Logging adds a buffer append (microseconds) on the hot path and one batched HTTP round-trip off it, so the logging pipeline is nowhere near the bottleneck until very high RPS — at which point the worker/bus scale out before the chat does.

## Failure handling

| Failure | Behaviour |
|---|---|
| Ingestion service down | SDK buffers and retries; **chat unaffected**. Buffer is bounded (drop-oldest, surfaced via `onDrop`). |
| Redis down | Ingestion returns `503`; SDK holds the batch and retries. |
| Worker down | Logs accumulate durably in the stream; a restarted/added worker resumes from the last acked ID. No loss. |
| Worker crashes mid-batch | Unacked entries are reclaimed by `XAUTOCLAIM` after an idle timeout and reprocessed. |
| Duplicate delivery | `UNIQUE(request_id)` + `ON CONFLICT DO NOTHING` makes it a no-op. |
| Postgres write fails in worker | Entry is left unacked → retried; it is never `XACK`ed without a durable write. |
| Malformed log | Rejected at ingestion with `422` (zod); unparseable stream entries are acked-and-dropped so they can't poison the group. |
| User cancels mid-stream | `AbortSignal` propagates to the provider; the partial assistant message is saved (so resume keeps context) and the call is logged with status `cancelled`. |
| No API key configured | Falls back to the mock provider; everything still runs. |

## Security / privacy notes

- PII redaction happens **before** previews are written, so raw PII isn't at rest in the log store. The regex detector is intentionally conservative and swappable for a real detector (Presidio/NER) behind the same interface.
- API keys are read from the environment only and never logged or sent to the browser (`pg`, the SDK, and provider keys are all server-side; `serverComponentsExternalPackages` keeps them out of client bundles).
- The log envelope carries previews only — full conversation content lives solely in the transcript tables the chat app owns.
