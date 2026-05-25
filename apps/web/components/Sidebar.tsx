"use client";

import { useEffect } from "react";

export interface ConvSummary {
  id: string;
  title: string | null;
  status: "active" | "cancelled";
  model: string | null;
  provider: string | null;
  updated_at: string;
  msg_count?: string;
}

export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onCancel,
  onRefresh,
}: {
  conversations: ConvSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onCancel: (id: string) => void;
  onRefresh: () => void;
}) {
  useEffect(() => {
    const t = setInterval(onRefresh, 8000);
    return () => clearInterval(t);
  }, [onRefresh]);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-ink-900/60">
      <div className="p-3">
        <button
          onClick={onNew}
          className="w-full rounded-md border border-line bg-ink-700 px-3 py-2 text-left font-mono text-xs text-zinc-200 transition hover:border-cyan/50 hover:text-cyan"
        >
          + new conversation
        </button>
      </div>
      <div className="px-3 pb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        conversations
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 && (
          <p className="px-2 py-4 text-xs text-zinc-600">
            No conversations yet.
          </p>
        )}
        {conversations.map((c) => {
          const active = c.id === activeId;
          return (
            <div
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`group mb-1 cursor-pointer rounded-md border px-2.5 py-2 transition ${
                active
                  ? "border-cyan/40 bg-cyan/5"
                  : "border-transparent hover:bg-ink-700/60"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] text-zinc-200">
                  {c.title || "Untitled"}
                </span>
                {c.status === "cancelled" ? (
                  <span className="shrink-0 rounded bg-rose-dim px-1.5 py-0.5 font-mono text-[9px] text-rose">
                    cancelled
                  </span>
                ) : (
                  <button
                    title="Cancel conversation"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancel(c.id);
                    }}
                    className="shrink-0 rounded px-1 font-mono text-[11px] text-zinc-600 opacity-0 transition hover:text-rose group-hover:opacity-100"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-zinc-500">
                {c.model && <span className="truncate">{c.model}</span>}
                <span>·</span>
                <span>{c.msg_count ?? 0} msgs</span>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
