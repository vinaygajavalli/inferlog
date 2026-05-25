import Redis from "ioredis";
import { makePool, insertLog, type LogRow } from "./db.js";
import { redact } from "./redact.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://inferlog:inferlog@localhost:5432/inferlog";
const STREAM_KEY = "inferlog:logs";
const GROUP = "ingest-workers";
const CONSUMER = process.env.HOSTNAME ?? `worker-${process.pid}`;
const BLOCK_MS = 5000;
const BATCH = 50;

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const pool = makePool(DATABASE_URL);

async function ensureGroup() {
  try {
    await redis.xgroup("CREATE", STREAM_KEY, GROUP, "$", "MKSTREAM");
  } catch (e: any) {
    if (!String(e?.message).includes("BUSYGROUP")) throw e;
  }
}

/** Transform a validated SDK log into a DB row, redacting previews. */
function toRow(log: any): LogRow {
  const input = redact(log.inputPreview);
  const output = redact(log.outputPreview);
  return {
    requestId: log.requestId,
    conversationId: log.conversationId,
    messageId: log.messageId,
    provider: log.provider,
    model: log.model,
    streaming: !!log.streaming,
    status: log.status,
    errorType: log.errorType,
    errorMessage: log.errorMessage,
    latencyMs: log.latencyMs,
    ttftMs: log.ttftMs,
    promptTokens: log.promptTokens,
    completionTokens: log.completionTokens,
    totalTokens: log.totalTokens,
    tokensEstimated: log.tokensEstimated,
    inputPreview: input.text,
    outputPreview: output.text,
    piiRedacted: input.redacted || output.redacted,
    requestedAt: log.requestedAt,
    completedAt: log.completedAt,
    metadata: log.metadata ?? {},
  };
}

async function processEntry(id: string, payload: string) {
  let log: any;
  try {
    log = JSON.parse(payload);
  } catch {
    // unparseable -> ack and drop, don't poison the group
    await redis.xack(STREAM_KEY, GROUP, id);
    return;
  }
  try {
    await insertLog(pool, toRow(log));
    await redis.xack(STREAM_KEY, GROUP, id); // ack only after durable write
  } catch (err) {
    console.error("[worker] insert failed, leaving unacked for retry", err);
    // not acked -> XAUTOCLAIM/redelivery will retry it later
  }
}

async function reclaimStuck() {
  // pick up entries from dead consumers idle > 30s
  try {
    const res: any = await redis.xautoclaim(
      STREAM_KEY,
      GROUP,
      CONSUMER,
      30_000,
      "0",
      "COUNT",
      BATCH,
    );
    const entries = res?.[1] ?? [];
    for (const [id, fields] of entries) {
      const payload = fieldVal(fields, "payload");
      if (payload) await processEntry(id, payload);
    }
  } catch (err) {
    console.error("[worker] xautoclaim error", err);
  }
}

function fieldVal(fields: string[], key: string): string | undefined {
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === key) return fields[i + 1];
  }
  return undefined;
}

async function loop() {
  await ensureGroup();
  console.log(`[worker] ${CONSUMER} consuming ${STREAM_KEY} group=${GROUP}`);
  let sinceReclaim = 0;
  while (running) {
    if (sinceReclaim++ % 10 === 0) await reclaimStuck();
    let res: any;
    try {
      res = await redis.xreadgroup(
        "GROUP",
        GROUP,
        CONSUMER,
        "COUNT",
        BATCH,
        "BLOCK",
        BLOCK_MS,
        "STREAMS",
        STREAM_KEY,
        ">",
      );
    } catch (err) {
      console.error("[worker] xreadgroup error", err);
      await sleep(1000);
      continue;
    }
    if (!res) continue;
    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        const payload = fieldVal(fields, "payload");
        if (payload) await processEntry(id, payload);
        else await redis.xack(STREAM_KEY, GROUP, id);
      }
    }
  }
}

let running = true;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    running = false;
    await pool.end().catch(() => {});
    redis.disconnect();
    process.exit(0);
  });
}

loop().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
