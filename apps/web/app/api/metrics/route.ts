import { NextRequest } from "next/server";
import { pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/metrics?minutes=60
 * Returns the numbers behind the dashboard: headline KPIs, a per-minute
 * timeseries (throughput + errors + latency), and a provider/model breakdown.
 * All computed in SQL so the payload stays small.
 */
export async function GET(req: NextRequest) {
  const minutes = clamp(
    Number(req.nextUrl.searchParams.get("minutes") ?? 60),
    5,
    1440,
  );
  const since = `now() - interval '${minutes} minutes'`;

  const [summary, series, providers, recent] = await Promise.all([
    pool.query(
      `SELECT
         count(*)                                            AS total,
         count(*) FILTER (WHERE status = 'error')            AS errors,
         count(*) FILTER (WHERE status = 'cancelled')        AS cancelled,
         coalesce(sum(total_tokens), 0)                      AS tokens,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99,
         avg(ttft_ms) FILTER (WHERE streaming)               AS avg_ttft
       FROM inference_logs
       WHERE requested_at >= ${since}`,
    ),
    pool.query(
      `SELECT
         date_trunc('minute', requested_at)                   AS bucket,
         count(*)                                             AS requests,
         count(*) FILTER (WHERE status = 'error')             AS errors,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
       FROM inference_logs
       WHERE requested_at >= ${since}
       GROUP BY bucket
       ORDER BY bucket ASC`,
    ),
    pool.query(
      `SELECT
         provider, model,
         count(*)                                             AS requests,
         count(*) FILTER (WHERE status = 'error')             AS errors,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
         coalesce(sum(total_tokens), 0)                       AS tokens
       FROM inference_logs
       WHERE requested_at >= ${since}
       GROUP BY provider, model
       ORDER BY requests DESC`,
    ),
    pool.query(
      `SELECT request_id, provider, model, status, streaming,
              latency_ms, ttft_ms, total_tokens, pii_redacted,
              input_preview, output_preview, error_type, requested_at
       FROM inference_logs
       WHERE requested_at >= ${since}
       ORDER BY requested_at DESC
       LIMIT 30`,
    ),
  ]);

  const s = summary.rows[0];
  const total = Number(s.total);
  return Response.json({
    window_minutes: minutes,
    summary: {
      total,
      errors: Number(s.errors),
      cancelled: Number(s.cancelled),
      error_rate: total ? Number(s.errors) / total : 0,
      throughput_rpm: total / minutes,
      tokens: Number(s.tokens),
      p50_ms: round(s.p50),
      p95_ms: round(s.p95),
      p99_ms: round(s.p99),
      avg_ttft_ms: round(s.avg_ttft),
    },
    series: series.rows.map((r) => ({
      t: r.bucket,
      requests: Number(r.requests),
      errors: Number(r.errors),
      p95: round(r.p95),
    })),
    providers: providers.rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      requests: Number(r.requests),
      errors: Number(r.errors),
      p50_ms: round(r.p50),
      tokens: Number(r.tokens),
    })),
    recent: recent.rows,
  });
}

const round = (v: unknown) => (v == null ? null : Math.round(Number(v)));
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
