'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

/**
 * Cost dashboard — visualises the LLM token-usage ledger written by
 * @omadia/usage-telemetry. Reads GET /api/usage/dashboard (via the /bot-api
 * proxy) and renders KPI cards, per-model / per-source breakdowns, and a cost
 * time series. Labels resolve from the i18n catalog under `adminUsage`.
 */

interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  cacheHitRatio: number;
}
interface UsageByKey {
  key: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}
interface UsageBucket {
  bucket: string;
  costUsd: number;
  calls: number;
}
interface UsageDashboard {
  totals: UsageTotals;
  byModel: UsageByKey[];
  bySource: UsageByKey[];
  timeSeries: UsageBucket[];
}

type RangeKey = '24h' | '7d' | '30d' | 'all';

// `labelKey` resolves under `adminUsage.ranges` — translated at render.
const RANGES: ReadonlyArray<{ key: RangeKey; labelKey: string; hours: number | null; bucket: 'hour' | 'day' }> = [
  { key: '24h', labelKey: 'last24h', hours: 24, bucket: 'hour' },
  { key: '7d', labelKey: 'last7d', hours: 24 * 7, bucket: 'day' },
  { key: '30d', labelKey: 'last30d', hours: 24 * 30, bucket: 'day' },
  { key: 'all', labelKey: 'all', hours: null, bucket: 'day' },
];

const usd = (n: number): string =>
  n >= 1
    ? `$${n.toFixed(2)}`
    : n > 0
      ? `$${n.toFixed(4)}`
      : '$0.00';
const compact = (n: number): string => new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export default function UsageDashboardPage(): React.ReactElement {
  const t = useTranslations('adminUsage');
  const [range, setRange] = useState<RangeKey>('24h');
  const [data, setData] = useState<UsageDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // No setState before the first `await` — keeping the effect free of
  // synchronous state updates (react-hooks/set-state-in-effect). The loading
  // flag is toggled by the range buttons + initial state instead.
  const load = useCallback(async (key: RangeKey): Promise<void> => {
    const cfg = RANGES.find((r) => r.key === key) ?? RANGES[0]!;
    const params = new URLSearchParams({ bucket: cfg.bucket });
    if (cfg.hours !== null) {
      params.set('since', new Date(Date.now() - cfg.hours * 3_600_000).toISOString());
    }
    try {
      const res = await fetch(`/bot-api/usage/dashboard?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as UsageDashboard;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // queueMicrotask defers the setState-bearing fetch out of the effect body
    // (react-hooks/set-state-in-effect) — same pattern as the inconsistencies
    // admin page.
    queueMicrotask(() => void load(range));
  }, [range, load]);

  const selectRange = useCallback((key: RangeKey): void => {
    setLoading(true);
    setRange(key);
  }, []);

  const maxSeries = useMemo(
    () => Math.max(1, ...(data?.timeSeries.map((b) => b.costUsd) ?? [0])),
    [data],
  );
  const maxModelCost = useMemo(
    () => Math.max(1e-9, ...(data?.byModel.map((m) => m.costUsd) ?? [0])),
    [data],
  );
  const maxSourceCost = useMemo(
    () => Math.max(1e-9, ...(data?.bySource.map((s) => s.costUsd) ?? [0])),
    [data],
  );

  return (
    <main className="mx-auto max-w-[1080px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
            {t('title')}
          </h1>
          <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
            {t('intro')}
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-[color:var(--border)] p-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => selectRange(r.key)}
              className={`rounded-md px-3 py-2 text-sm transition-colors ${
                range === r.key
                  ? 'bg-[color:var(--accent)] text-[color:var(--fg-on-dark)]'
                  : 'text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]'
              }`}
            >
              {t(`ranges.${r.labelKey}`)}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/10 px-4 py-3 text-sm text-[color:var(--danger)]">
          {t('loadError', { message: error })}
        </div>
      )}

      {loading && !data ? (
        <p className="text-[color:var(--fg-muted)]">{t('loading')}</p>
      ) : data ? (
        <>
          <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label={t('kpi.totalCost')} value={usd(data.totals.costUsd)} />
            <Kpi label={t('kpi.calls')} value={compact(data.totals.calls)} />
            <Kpi
              label={t('kpi.cacheHitRate')}
              value={pct(data.totals.cacheHitRatio)}
              hint={t('kpi.cacheHitHint')}
            />
            <Kpi
              label={t('kpi.tokens')}
              value={`${compact(data.totals.inputTokens)} / ${compact(data.totals.outputTokens)}`}
            />
          </section>

          <Panel title={t('panels.costOverTime')}>
            {data.timeSeries.length === 0 ? (
              <Empty />
            ) : (
              <div className="flex h-40 items-end gap-1">
                {data.timeSeries.map((b) => (
                  <div
                    key={b.bucket}
                    className="group relative flex-1"
                    title={t('barTitle', {
                      date: new Date(b.bucket).toLocaleString('de-DE'),
                      cost: usd(b.costUsd),
                      calls: b.calls,
                    })}
                  >
                    <div
                      className="w-full rounded-t bg-[color:var(--accent)]/70 transition-colors group-hover:bg-[color:var(--accent)]"
                      style={{ height: `${Math.max(2, (b.costUsd / maxSeries) * 100)}%` }}
                    />
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Panel title={t('panels.byModel')}>
              <BreakdownTable rows={data.byModel} max={maxModelCost} />
            </Panel>
            <Panel title={t('panels.bySource')}>
              <BreakdownTable rows={data.bySource} max={maxSourceCost} />
            </Panel>
          </div>
        </>
      ) : null}
    </main>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }): React.ReactElement {
  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
      <div className="text-xs uppercase tracking-wide text-[color:var(--fg-muted)]">{label}</div>
      <div className="mt-2 font-display text-[28px] leading-none text-[color:var(--fg-strong)]">{value}</div>
      {hint && <div className="mt-2 text-xs text-[color:var(--fg-muted)]">{hint}</div>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
      <h2 className="mb-4 text-[15px] font-semibold text-[color:var(--fg-strong)]">{title}</h2>
      {children}
    </section>
  );
}

function Empty(): React.ReactElement {
  const t = useTranslations('adminUsage');
  return <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>;
}

function BreakdownTable({ rows, max }: { rows: UsageByKey[]; max: number }): React.ReactElement {
  const t = useTranslations('adminUsage');
  if (rows.length === 0) return <Empty />;
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium text-[color:var(--fg-strong)]">{r.key}</span>
            <span className="shrink-0 tabular-nums text-[color:var(--fg-strong)]">{usd(r.costUsd)}</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--border)]">
            <div
              className="h-full rounded-full bg-[color:var(--accent)]"
              style={{ width: `${(r.costUsd / max) * 100}%` }}
            />
          </div>
          <div className="mt-1 text-xs text-[color:var(--fg-muted)]">
            {t('rowStats', {
              calls: compact(r.calls),
              input: compact(r.inputTokens),
              output: compact(r.outputTokens),
              cache: compact(r.cacheReadTokens),
            })}
          </div>
        </li>
      ))}
    </ul>
  );
}
