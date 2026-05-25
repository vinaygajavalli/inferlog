import { encode } from "gpt-tokenizer";
import type { ChatMessage } from "./types.js";

/**
 * Best-effort token count when the provider doesn't report usage (common with
 * some streaming endpoints). Uses the GPT BPE tokenizer as a reasonable proxy
 * across providers — it won't match Anthropic/Gemini exactly, but it's close
 * enough for dashboards and is always flagged `estimated: true` downstream.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // very rough fallback: ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}

export function estimatePromptTokens(messages: ChatMessage[]): number {
  // +4 tokens/message is the usual overhead approximation for chat formats
  return messages.reduce(
    (sum, m) => sum + estimateTokens(m.content) + 4,
    0,
  );
}
