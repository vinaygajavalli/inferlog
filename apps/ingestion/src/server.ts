import Fastify from "fastify";
import { BatchSchema } from "./schema.js";
import { makeRedis, STREAM_KEY } from "./redis.js";

const PORT = Number(process.env.PORT ?? 4000);
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
const redis = makeRedis(REDIS_URL);

app.get("/health", async () => {
  const ping = await redis.ping().catch(() => "FAIL");
  return { ok: ping === "PONG", redis: ping };
});

/**
 * Receives a batch of logs from the SDK. Flow:
 *   1. validate the whole batch with zod (reject malformed early)
 *   2. publish each log onto the Redis stream (the event)
 *   3. ack 202 — persistence is the worker's job, asynchronously
 *
 * We accept-then-process rather than write to Postgres inline so a slow DB
 * never back-pressures the chat app, and so we can scale ingestion and storage
 * independently.
 */
app.post("/v1/logs", async (req, reply) => {
  const parsed = BatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(422).send({
      error: "invalid_payload",
      issues: parsed.error.issues.slice(0, 20),
    });
  }

  try {
    // sequential xadd keeps ordering; pipeline for throughput at scale
    const pipeline = redis.pipeline();
    for (const log of parsed.data.logs) {
      pipeline.xadd(STREAM_KEY, "*", "payload", JSON.stringify(log));
    }
    await pipeline.exec();
  } catch (err) {
    req.log.error({ err }, "failed to publish to stream");
    // tell the SDK to retry — its buffer will hold the batch
    return reply.code(503).send({ error: "bus_unavailable" });
  }

  return reply.code(202).send({ accepted: parsed.data.logs.length });
});

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then((addr) => app.log.info(`ingestion listening on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    redis.disconnect();
    process.exit(0);
  });
}
