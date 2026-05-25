import { NextRequest } from "next/server";
import type { ChatMessage } from "@inferlog/logger";
import { resolveProvider } from "@/lib/providers";
import {
  addMessage,
  getConversation,
  setConversationMeta,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTEXT_WINDOW = 20; // last N messages kept as conversational context

/**
 * POST /api/chat  { conversationId, message }
 *
 * Streams the assistant reply as Server-Sent Events. Two persistence paths:
 *  - transcript (user + assistant messages)  -> synchronous DB writes here
 *  - inference log (latency/tokens/status)    -> fire-and-forget via the SDK
 *
 * Cancellation: the browser aborts the fetch; req.signal fires; we forward that
 * to the provider so the upstream call actually stops, and the SDK logs the
 * call as `cancelled` with whatever partial output we had.
 */
export async function POST(req: NextRequest) {
  const { conversationId, message, provider: providerName } = await req.json();
  if (!conversationId || typeof message !== "string" || !message.trim()) {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
    });
  }

  const existing = await getConversation(conversationId);
  if (!existing) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
    });
  }
  if (existing.conversation.status === "cancelled") {
    return new Response(JSON.stringify({ error: "conversation_cancelled" }), {
      status: 409,
    });
  }

  // persist the user's turn first (source of truth for the transcript)
  await addMessage(conversationId, "user", message);
  if (!existing.conversation.title) {
    await setConversationMeta(conversationId, {
      title: message.slice(0, 60),
    });
  }

  const history: ChatMessage[] = existing.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  history.push({ role: "user", content: message });
  const context = history.slice(-CONTEXT_WINDOW);

  const entry = resolveProvider(providerName);
  const logger = entry.logger;
  const provider = entry.name;
  const defaultModel = entry.model;
  await setConversationMeta(conversationId, { model: defaultModel, provider });

  const encoder = new TextEncoder();
  let assistantText = "";

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      try {
        send("meta", { model: defaultModel, provider });
        const gen = logger.stream({
          model: defaultModel,
          messages: context,
          conversationId,
          signal: req.signal, // cancellation propagation
          metadata: { surface: "chat" },
        });
        for await (const delta of gen) {
          assistantText += delta;
          send("delta", { text: delta });
        }
        // persist the completed assistant turn
        await addMessage(conversationId, "assistant", assistantText);
        send("done", { text: assistantText });
      } catch (err: any) {
        if (req.signal.aborted || err?.name === "AbortError") {
          // save the partial so a resumed conversation isn't missing context
          if (assistantText)
            await addMessage(conversationId, "assistant", assistantText).catch(
              () => {},
            );
          send("cancelled", { text: assistantText });
        } else {
          send("error", { message: String(err?.message ?? err) });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
