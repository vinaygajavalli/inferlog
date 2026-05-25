import Redis from "ioredis";
import type { ValidatedLog } from "./schema.js";

export const STREAM_KEY = "inferlog:logs";

/**
 * Redis Streams as the event bus. Chosen over plain pub/sub because streams are
 * durable and support consumer groups — a crashed worker can resume from the
 * last acked id instead of losing in-flight events. Kafka/NATS would be the
 * next step at higher volume; the producer/consumer split here is intentionally
 * the same shape so swapping the bus is a localized change.
 */
export function makeRedis(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export async function publish(redis: Redis, log: ValidatedLog): Promise<void> {
  // Single field `payload` keeps the stream entry simple; the worker JSON-parses it.
  await redis.xadd(STREAM_KEY, "*", "payload", JSON.stringify(log));
}
