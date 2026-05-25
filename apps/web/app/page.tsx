"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sidebar, type ConvSummary } from "@/components/Sidebar";

interface Msg {
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
}

export default function ChatPage() {
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<"active" | "cancelled">("active");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [meta, setMeta] = useState<{ provider?: string; model?: string }>({});
  const [providers, setProviders] = useState<{ name: string; model: string }[]>(
    [],
  );
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/conversations");
    const j = await r.json();
    setConversations(j.conversations);
  }, []);

  useEffect(() => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then((j) => {
        setProviders(j.providers ?? []);
        setSelectedProvider(j.default ?? j.providers?.[0]?.name ?? "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 1e9, behavior: "smooth" });
  }, [messages]);

  async function newConversation() {
    const r = await fetch("/api/conversations", { method: "POST" });
    const j = await r.json();
    await refresh();
    selectConversation(j.conversation.id);
  }

  async function selectConversation(id: string) {
    abortRef.current?.abort();
    const r = await fetch(`/api/conversations/${id}`);
    if (!r.ok) return;
    const j = await r.json();
    setActiveId(id);
    setStatus(j.conversation.status);
    setMeta({ provider: j.conversation.provider, model: j.conversation.model });
    setMessages(
      j.messages
        .filter((m: any) => m.role !== "system")
        .map((m: any) => ({ role: m.role, content: m.content })),
    );
  }

  async function cancelConversation(id: string) {
    abortRef.current?.abort();
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (id === activeId) setStatus("cancelled");
    refresh();
  }

  function stopStreaming() {
    abortRef.current?.abort();
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    let convId = activeId;
    if (!convId) {
      const r = await fetch("/api/conversations", { method: "POST" });
      const j = await r.json();
      convId = j.conversation.id;
      setActiveId(convId);
    }

    setInput("");
    setMessages((m) => [
      ...m,
      { role: "user", content: text },
      { role: "assistant", content: "", pending: true },
    ]);
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: convId,
          message: text,
          provider: selectedProvider || undefined,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`http ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const ev = parseSSE(frame);
          if (!ev) continue;
          if (ev.event === "meta") setMeta(ev.data);
          if (ev.event === "delta") appendDelta(ev.data.text);
          if (ev.event === "done" || ev.event === "cancelled")
            finalize(ev.data.text);
          if (ev.event === "error") finalize(`⚠ ${ev.data.message}`);
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") finalize("⚠ request failed");
    } finally {
      setStreaming(false);
      abortRef.current = null;
      refresh();
    }
  }

  function appendDelta(t: string) {
    setMessages((m) => {
      const copy = [...m];
      const last = copy[copy.length - 1];
      if (last?.role === "assistant")
        copy[copy.length - 1] = {
          ...last,
          content: last.content + t,
          pending: true,
        };
      return copy;
    });
  }

  function finalize(t: string) {
    setMessages((m) => {
      const copy = [...m];
      const last = copy[copy.length - 1];
      if (last?.role === "assistant")
        copy[copy.length - 1] = {
          role: "assistant",
          content: t || last.content,
          pending: false,
        };
      return copy;
    });
  }

  const disabled = status === "cancelled";

  return (
    <div className="flex h-full">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={selectConversation}
        onNew={newConversation}
        onCancel={cancelConversation}
        onRefresh={refresh}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-line px-5 py-2.5">
          <div className="font-mono text-xs text-zinc-500">
            {activeId ? (
              <>
                <span className="text-zinc-300">{meta.provider ?? "—"}</span>
                <span className="mx-1.5 text-zinc-600">/</span>
                <span className="text-cyan">{meta.model ?? "—"}</span>
              </>
            ) : (
              "no conversation selected"
            )}
          </div>
          <div className="flex items-center gap-3">
            {disabled && (
              <span className="rounded bg-rose-dim px-2 py-0.5 font-mono text-[10px] text-rose">
                conversation cancelled
              </span>
            )}
            {providers.length > 0 && (
              <label className="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
                provider
                <select
                  value={selectedProvider}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                  className="rounded-md border border-line bg-ink-800 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none focus:border-cyan/50"
                >
                  {providers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name} / {p.model}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <div className="mx-auto max-w-3xl space-y-5">
            {messages.length === 0 && (
              <div className="mt-24 text-center">
                <p className="font-mono text-sm text-zinc-500">
                  Start a conversation. Every call is logged through the SDK →
                  ingestion → worker → Postgres.
                </p>
                <p className="mt-2 font-mono text-xs text-zinc-700">
                  Watch it land on the dashboard in near real time.
                </p>
              </div>
            )}
            {messages.map((m, i) => (
              <Bubble key={i} msg={m} streaming={streaming} />
            ))}
          </div>
        </div>

        <div className="border-t border-line p-4">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              disabled={disabled}
              rows={1}
              placeholder={
                disabled ? "This conversation was cancelled" : "Message…"
              }
              className="max-h-40 min-h-[44px] flex-1 resize-none rounded-lg border border-line bg-ink-800 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-cyan/50 disabled:opacity-50"
            />
            {streaming ? (
              <button
                onClick={stopStreaming}
                className="h-[44px] rounded-lg border border-rose/40 bg-rose-dim px-4 font-mono text-xs text-rose transition hover:bg-rose/10"
              >
                stop ■
              </button>
            ) : (
              <button
                onClick={send}
                disabled={disabled || !input.trim()}
                className="h-[44px] rounded-lg bg-cyan px-4 font-mono text-xs font-semibold text-ink-900 transition hover:brightness-110 disabled:opacity-30"
              >
                send ↵
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Bubble({ msg, streaming }: { msg: Msg; streaming: boolean }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] ${isUser ? "text-right" : ""}`}>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
          {msg.role}
        </div>
        <div
          className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed ${
            isUser
              ? "rounded-tr-sm bg-cyan/10 text-zinc-100"
              : "rounded-tl-sm border border-line bg-ink-800 text-zinc-200"
          } ${msg.pending && streaming ? "cursor-blink" : ""}`}
        >
          {msg.content}
        </div>
      </div>
    </div>
  );
}

function parseSSE(frame: string): { event: string; data: any } | null {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}
