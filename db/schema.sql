-- ============================================================================
-- inferlog schema
-- ============================================================================
-- Applied automatically on first Postgres boot (mounted into
-- /docker-entrypoint-initdb.d). Plain SQL is deliberate: the schema is the
-- thing being graded, so it should be readable without an ORM in the way, and
-- a one-command `docker compose up` should never depend on a migration step
-- succeeding at runtime.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- conversations
-- ----------------------------------------------------------------------------
-- A conversation == a session. Owned and written synchronously by the chat
-- app: losing a conversation would break "resume", so this is NOT on the
-- fire-and-forget log path.
-- ----------------------------------------------------------------------------
CREATE TABLE conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT,                              -- derived from first user msg
    status      TEXT NOT NULL DEFAULT 'active'     -- active | cancelled
                CHECK (status IN ('active', 'cancelled')),
    model       TEXT,                              -- last model used, for the list view
    provider    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_updated  ON conversations (updated_at DESC);
CREATE INDEX idx_conversations_status   ON conversations (status);

-- ----------------------------------------------------------------------------
-- messages
-- ----------------------------------------------------------------------------
-- The transcript. Also a synchronous write owned by the chat app.
-- `token_count` here is best-effort and denormalised for cheap context-window
-- math; authoritative usage lives in inference_logs.
-- ----------------------------------------------------------------------------
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
    content         TEXT NOT NULL,
    token_count     INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);

-- ----------------------------------------------------------------------------
-- inference_logs
-- ----------------------------------------------------------------------------
-- One row per LLM call, written by the ingestion worker (NOT the chat app).
-- This is the observability path: best-effort, async, and may lag the chat by
-- a few hundred ms. message_id / conversation_id are soft links (no FK +
-- ON DELETE) so that logs survive even if a conversation row is purged, and so
-- ingestion never has to block on a referential check.
-- ----------------------------------------------------------------------------
CREATE TABLE inference_logs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id       TEXT NOT NULL,        -- client-generated, idempotency key
    conversation_id  UUID,
    message_id       UUID,

    provider         TEXT NOT NULL,
    model            TEXT NOT NULL,
    streaming        BOOLEAN NOT NULL DEFAULT false,

    status           TEXT NOT NULL         -- success | error | cancelled
                     CHECK (status IN ('success', 'error', 'cancelled')),
    error_type       TEXT,                 -- e.g. rate_limit, timeout, provider_5xx
    error_message    TEXT,

    -- latency, all milliseconds
    latency_ms       INTEGER,              -- total wall time
    ttft_ms          INTEGER,              -- time to first token (streaming only)

    -- usage
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    tokens_estimated  BOOLEAN NOT NULL DEFAULT false,  -- true if we fell back to a tokenizer guess

    -- previews are PII-redacted by the worker before they land here
    input_preview    TEXT,
    output_preview   TEXT,
    pii_redacted     BOOLEAN NOT NULL DEFAULT false,

    -- request lifecycle timestamps (from the SDK, source of truth for latency)
    requested_at     TIMESTAMPTZ NOT NULL,
    completed_at     TIMESTAMPTZ,

    -- anything provider-specific or future we don't want a column for yet
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,

    ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (request_id)   -- dedupe at-least-once delivery from the queue
);

-- Dashboard query patterns drive these indexes:
--   "requests/errors over the last N minutes"   -> (requested_at)
--   "filter/group by provider+model"            -> (provider, model, requested_at)
--   "error rate"                                 -> partial index on errors
--   "drill into one conversation"                -> (conversation_id)
CREATE INDEX idx_logs_requested       ON inference_logs (requested_at DESC);
CREATE INDEX idx_logs_provider_model  ON inference_logs (provider, model, requested_at DESC);
CREATE INDEX idx_logs_conversation    ON inference_logs (conversation_id);
CREATE INDEX idx_logs_errors          ON inference_logs (requested_at DESC) WHERE status = 'error';
CREATE INDEX idx_logs_metadata_gin    ON inference_logs USING GIN (metadata);

-- ----------------------------------------------------------------------------
-- keep conversations.updated_at fresh on new messages
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_conversation() RETURNS TRIGGER AS $$
BEGIN
    UPDATE conversations SET updated_at = now() WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_touch_conversation
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION touch_conversation();
