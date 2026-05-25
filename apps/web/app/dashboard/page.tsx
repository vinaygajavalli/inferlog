"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Metrics {
  window_minutes: number;
  summary: {
    total: number;
    errors: number;
    cancelled: number;
    error_rate: number;
    throughput_rpm: number;
    tokens: number;
    p50_ms: number | null;
    p95_ms: number | null;
    p99_ms: number | null;
    avg_ttft_ms: number | null;
  };
  series: { t: string; requests: number; errors: number; p95: number | null }[];
  providers: {
    provider: string;
    model: string;
    requests: number;
    errors: number;
    p50_ms: number | null;
    tokens: number;
  }[];
  recent: any[];
}

const WINDOWS = [
  { label: "15m", v: 15 },
  { label: "1h", v: 60 },
  { label: "6h", v: 360 },
  { label: "24h", v: 1440 },
];

export default function DashboardPage() {
  const [data, setData] = useState<Metrics | null>(null);
  const [minutes, setMinutes] = useState(60);
  const [live, setLive] = useState(true);

  const load = useCallback(async () => {
    const r = await fetch(`/api/metrics?minutes=${minutes}`);
    setData(await r.json());
  }, [minutes]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [live, load]);

  const s = data?.summary;
  const series = (data?.series ?? []).map((p) => ({
    ...p,
    label: new Date(p.t).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
  }));

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="font-mono text-lg font-bold">observability</h1>
            <p className="font-mono text-xs text-zinc-500">
              inference logs · last {data?.window_minutes ?? minutes} min
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex rounded-md border border-line bg-ink-800 p-0.5">
              {WINDOWS.map((w) => (
                <button
                  key={w.v}
                  onClick={() => setMinutes(w.v)}
                  className={`rounded px-2.5 py-1 font-mono text-xs transition ${
                    minutes === w.v
                      ? "bg-ink-600 text-cyan"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setLive((v) => !v)}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-xs transition ${
                live
                  ? "border-signal/40 text-signal"
                  : "border-line text-zinc-500"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  live ? "animate-pulse bg-signal" : "bg-zinc-600"
                }`}
              />
              live
            </button>
          </div>
        </div>

        {/* KPI row */}
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          <Kpi label="requests" value={s ? fmt(s.total) : "—"} />
          <Kpi
            label="throughput"
            value={s ? `${s.throughput_rpm.toFixed(1)}` : "—"}
            unit="/min"
          />
          <Kpi
            label="error rate"
            value={s ? `${(s.error_rate * 100).toFixed(1)}` : "—"}
            unit="%"
            tone={s && s.error_rate > 0.1 ? "rose" : "signal"}
          />
          <Kpi label="p50" value={s?.p50_ms != null ? fmt(s.p50_ms) : "—"} unit="ms" />
          <Kpi
            label="p95"
            value={s?.p95_ms != null ? fmt(s.p95_ms) : "—"}
            unit="ms"
            tone="amber"
          />
          <Kpi
            label="ttft"
            value={s?.avg_ttft_ms != null ? fmt(s.avg_ttft_ms) : "—"}
            unit="ms"
            tone="cyan"
          />
        </div>

        {/* charts */}
        <div className="mb-5 grid gap-3 lg:grid-cols-2">
          <Panel title="throughput / errors (per min)">
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={series}>
                <defs>
                  <linearGradient id="req" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1e2530" vertical={false} />
                <XAxis dataKey="label" stroke="#3f4855" fontSize={10} tickLine={false} />
                <YAxis stroke="#3f4855" fontSize={10} tickLine={false} width={28} />
                <Tooltip content={<DarkTip />} />
                <Area
                  type="monotone"
                  dataKey="requests"
                  stroke="#38bdf8"
                  fill="url(#req)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="errors"
                  stroke="#fb7185"
                  fill="none"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title="p95 latency (ms, per min)">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={series}>
                <CartesianGrid stroke="#1e2530" vertical={false} />
                <XAxis dataKey="label" stroke="#3f4855" fontSize={10} tickLine={false} />
                <YAxis stroke="#3f4855" fontSize={10} tickLine={false} width={36} />
                <Tooltip content={<DarkTip />} />
                <Line
                  type="monotone"
                  dataKey="p95"
                  stroke="#fbbf24"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </Panel>
        </div>

        {/* provider breakdown */}
        <Panel title="by provider / model">
          {data?.providers.length ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <ResponsiveContainer width="100%" height={Math.max(120, data.providers.length * 42)}>
                <BarChart data={data.providers} layout="vertical">
                  <XAxis type="number" stroke="#3f4855" fontSize={10} />
                  <YAxis
                    type="category"
                    dataKey="model"
                    stroke="#3f4855"
                    fontSize={10}
                    width={120}
                  />
                  <Tooltip content={<DarkTip />} cursor={{ fill: "#161b24" }} />
                  <Bar dataKey="requests" fill="#38bdf8" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="overflow-hidden rounded-md border border-line">
                <table className="w-full font-mono text-xs">
                  <thead className="bg-ink-700 text-zinc-500">
                    <tr>
                      <th className="px-2 py-1.5 text-left">provider</th>
                      <th className="px-2 py-1.5 text-right">req</th>
                      <th className="px-2 py-1.5 text-right">err</th>
                      <th className="px-2 py-1.5 text-right">p50</th>
                      <th className="px-2 py-1.5 text-right">tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.providers.map((p, i) => (
                      <tr key={i} className="border-t border-line text-zinc-300">
                        <td className="px-2 py-1.5">
                          {p.provider}
                          <span className="text-zinc-600"> /{p.model}</span>
                        </td>
                        <td className="px-2 py-1.5 text-right">{p.requests}</td>
                        <td className="px-2 py-1.5 text-right text-rose">
                          {p.errors}
                        </td>
                        <td className="px-2 py-1.5 text-right">{p.p50_ms ?? "—"}</td>
                        <td className="px-2 py-1.5 text-right">{fmt(p.tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <Empty />
          )}
        </Panel>

        {/* recent feed */}
        <div className="mt-5">
          <Panel title="recent inferences">
            {data?.recent.length ? (
              <div className="space-y-1.5">
                {data.recent.map((r) => (
                  <div
                    key={r.request_id}
                    className="flex items-center gap-3 rounded border border-line bg-ink-800 px-3 py-1.5 font-mono text-[11px]"
                  >
                    <StatusDot status={r.status} />
                    <span className="w-28 shrink-0 truncate text-zinc-400">
                      {r.provider}/{r.model}
                    </span>
                    <span className="w-14 shrink-0 text-right text-zinc-500">
                      {r.latency_ms ?? "—"}ms
                    </span>
                    <span className="w-16 shrink-0 text-right text-zinc-600">
                      {r.total_tokens ?? "—"} tok
                    </span>
                    {r.pii_redacted && (
                      <span className="rounded bg-amber-dim px-1 text-[9px] text-amber">
                        pii
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-zinc-500">
                      {r.output_preview || r.error_type || r.input_preview || ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  unit,
  tone = "default",
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "default" | "signal" | "rose" | "amber" | "cyan";
}) {
  const color = {
    default: "text-zinc-100",
    signal: "text-signal",
    rose: "text-rose",
    amber: "text-amber",
    cyan: "text-cyan",
  }[tone];
  return (
    <div className="rounded-lg border border-line bg-ink-800 px-3.5 py-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      <div className={`mt-1 font-mono text-xl font-bold ${color}`}>
        {value}
        {unit && <span className="ml-0.5 text-xs text-zinc-600">{unit}</span>}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-ink-900/40 p-4">
      <div className="mb-3 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
        {title}
      </div>
      {children}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const c =
    status === "success"
      ? "bg-signal"
      : status === "error"
        ? "bg-rose"
        : "bg-amber";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c}`} />;
}

function DarkTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border border-line bg-ink-900 px-2.5 py-1.5 font-mono text-[11px] shadow-xl">
      <div className="mb-0.5 text-zinc-400">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.dataKey}: {p.value}
        </div>
      ))}
    </div>
  );
}

const Empty = () => (
  <p className="py-6 text-center font-mono text-xs text-zinc-600">
    No data in this window yet — send a few chat messages.
  </p>
);

const fmt = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
