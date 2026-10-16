'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useFormatter, useTimeZone, useTranslations } from 'next-intl';

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
  /** OM-103 — subscription reference cost; informational, never billed. */
  referenceCostUsd: number;
  /** OM-103 — how many of `calls` ran on the subscription CLI. */
  subscriptionCalls: number;
  cacheHitRatio: number;
}
interface UsageByKey {
  key: string;
  calls: number;
  costUsd: number;
  referenceCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** #1393 — cache writes, often the largest share of a row's cost. */
  cacheCreationTokens: number;
  /** #1393 — `builder` folds every builder draft, `other` the tail past ten. */
  group?: 'builder' | 'other';
  /** #1393 — how many raw sources a grouped row folds. */
  members?: number;
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
type BucketSize = 'hour' | 'day';

const BUCKET_MS: Record<BucketSize, number> = { hour: 3_600_000, day: 86_400_000 };

/**
 * `labelKey` resolves under `adminUsage.ranges` — translated at render.
 * `buckets` is how many bars the range shows, the current one included: the
 * request asks from `buckets - 1` units back and the middleware floors that to
 * the bucket start in the operator's zone (#1396), so "7 days" is today plus
 * the six whole days before it, not a rolling 168 hours whose first bar is a
 * partial day. `null` = all time.
 */
const RANGES: ReadonlyArray<{ key: RangeKey; labelKey: string; buckets: number | null; bucket: BucketSize }> = [
  { key: '24h', labelKey: 'last24h', buckets: 24, bucket: 'hour' },
  { key: '7d', labelKey: 'last7d', buckets: 7, bucket: 'day' },
  { key: '30d', labelKey: 'last30d', buckets: 30, bucket: 'day' },
  { key: 'all', labelKey: 'all', buckets: null, bucket: 'day' },
];

/**
 * #679 / I6 — the ledger records cost in US dollars (`costUsd`, written by
 * `@omadia/usage-telemetry` from provider pricing).
 *
 * The currency is therefore NOT localised, and that is the point: converting
 * to euros for a German operator would require an exchange rate this app does
 * not have and cannot honestly invent — the resulting number would be a
 * fabrication presented as a ledger figure. What IS localised is the
 * PRESENTATION: symbol placement, decimal separator and grouping all follow
 * the active locale, so a German operator reads `1.234,56 $` instead of
 * `$1,234.56`. The amount stays the amount.
 */
const LEDGER_CURRENCY = 'USD';

/**
 * Per-call costs are routinely sub-cent, so two decimals would render most
 * rows as `$0.00` and lose the entire signal. Four decimals below one unit,
 * two at or above it — the same split the previous hardcoded formatter made,
 * kept deliberately rather than inherited by accident.
 */
function currencyDigits(n: number): number {
  return n > 0 && n < 1 ? 4 : 2;
}

interface UsageFormatters {
  /** Ledger cost, presented in the active locale. */
  usd: (n: number) => string;
  /** Token / call counts in compact notation (`1,2 Mio.` / `1.2M`). */
  compact: (n: number) => string;
  /** A 0–1 ratio as a percentage. */
  pct: (n: number) => string;
  /** A bucket start, in the active locale and zone: date only for a daily
   *  bucket (#1396 — a day has no time of day), date and time for an hour. */
  bucketLabel: (d: Date, bucket: BucketSize) => string;
}

/**
 * The three number formats this dashboard renders, all locale-aware.
 *
 * A hook rather than module-level helpers because the page and
 * `BreakdownTable` are separate components that need the same three formats —
 * and `useFormatter` can only be called from inside one. Duplicating the
 * options in both is how a currency ends up with four decimals in one table
 * and two in the next.
 */
function useUsageFormatters(): UsageFormatters {
  // next-intl's formatter, not a hand-built `Intl.NumberFormat`: `compact`
  // previously pinned `de-DE`, so an English operator read German grouping —
  // the mirror image of the bug #679 filed for the currency. Both now follow
  // the active locale (`web-ui/CLAUDE.md` § no hardcoded locale formatting).
  const format = useFormatter();
  return useMemo(
    () => ({
      usd: (n: number): string =>
        format.number(n, {
          style: 'currency',
          currency: LEDGER_CURRENCY,
          minimumFractionDigits: currencyDigits(n),
          maximumFractionDigits: currencyDigits(n),
        }),
      compact: (n: number): string =>
        format.number(n, { notation: 'compact', maximumFractionDigits: 1 }),
      // `style: 'percent'` scales by 100 itself, so the ratio goes in
      // unmultiplied.
      pct: (n: number): string =>
        format.number(n, { style: 'percent', maximumFractionDigits: 1 }),
      bucketLabel: (d: Date, bucket: BucketSize): string =>
        format.dateTime(
          d,
          bucket === 'day' ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' },
        ),
    }),
    [format],
  );
}

export default function UsageDashboardPage(): React.ReactElement {
  const t = useTranslations('adminUsage');
  const { usd, compact, pct, bucketLabel } = useUsageFormatters();
  // #1396 — the zone next-intl formats in (the `omadia-tz` cookie); the
  // middleware cuts the buckets in the same one, so a daily bar is a local day.
  const timeZone = useTimeZone();
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
    if (timeZone) params.set('tz', timeZone);
    if (cfg.buckets !== null) {
      // Half a bucket short of `buckets - 1` units: the middleware floors
      // `since` to its bucket start, and the margin keeps a DST shift (a
      // 23- or 25-hour day) from tipping it into one bucket too many.
      const unit = BUCKET_MS[cfg.bucket];
      const back = (cfg.buckets - 1) * unit - unit / 2;
      params.set('since', new Date(Date.now() - back).toISOString());
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
  }, [timeZone]);

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

  // Scaled to the busiest bucket, not to a fixed $1: a quiet week of cents
  // must still show bars. The floor only guards the division.
  const maxSeries = useMemo(
    () => Math.max(1e-9, ...(data?.timeSeries.map((b) => b.costUsd) ?? [0])),
    [data],
  );
  const bucketSize = RANGES.find((r) => r.key === range)?.bucket ?? 'hour';
  // The middleware returns idle buckets as zero rows (#1388), so "no usage"
  // is "no calls in any bucket", not an empty array.
  const seriesHasUsage = data?.timeSeries.some((b) => b.calls > 0) ?? false;
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
            // eslint-disable-next-line no-restricted-syntax -- stateful toggle/segmented selector
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

          {/*
            OM-103 — the page used to read "0 Calls" for an operator running
            purely on a Claude subscription, because the ledger only had
            capture points on the metered API path. Subscription turns are
            recorded now, and they need their own line: they have tokens but
            no per-call price, so folding them into "Gesamtkosten" would be a
            different lie than the one this replaces.
          */}
          {data.totals.subscriptionCalls > 0 && (
            <section className="mb-8 rounded-lg border border-[color:var(--edge)] px-4 py-3 text-sm text-[color:var(--fg-muted)]">
              <p className="text-[color:var(--fg-strong)]">
                {t('subscription.headline', { count: data.totals.subscriptionCalls })}
              </p>
              <p className="mt-1">
                {t('subscription.explainer', {
                  reference: usd(data.totals.referenceCostUsd),
                })}
              </p>
            </section>
          )}

          <Panel title={t('panels.costOverTime')}>
            {!seriesHasUsage ? (
              <Empty />
            ) : (
              <CostChart
                series={data.timeSeries}
                max={maxSeries}
                label={(b) =>
                  t('barTitle', {
                    date: bucketLabel(new Date(b.bucket), bucketSize),
                    cost: usd(b.costUsd),
                    calls: b.calls,
                  })
                }
                axisLabel={(b) => bucketLabel(new Date(b.bucket), bucketSize)}
              />
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

/**
 * #1388 — each bucket must span the full chart height. The container is
 * `items-end`, so a bucket without `h-full` is sized by its content, the bar's
 * percentage height resolves against an indefinite height, and every bar
 * collapsed to 0 px (and could not be hovered). The bucket is itself an
 * `items-end` flex box so the bar sits on the baseline. Idle buckets render no
 * bar; a non-zero one keeps a 2 % sliver so a cent next to a dollar still
 * shows. The axis names the first and last bucket — the tooltip has the rest.
 */
function CostChart({
  series,
  max,
  label,
  axisLabel,
}: {
  series: UsageBucket[];
  max: number;
  label: (b: UsageBucket) => string;
  axisLabel: (b: UsageBucket) => string;
}): React.ReactElement {
  const first = series[0];
  const last = series[series.length - 1];
  return (
    <div>
      <div className="flex h-40 items-end gap-1" data-testid="cost-chart">
        {series.map((b) => (
          <div
            key={b.bucket}
            className="group relative flex h-full flex-1 items-end"
            title={label(b)}
          >
            {b.costUsd > 0 && (
              <div
                className="w-full rounded-t bg-[color:var(--accent)]/70 transition-colors group-hover:bg-[color:var(--accent)]"
                style={{ height: `${Math.max(2, (b.costUsd / max) * 100)}%` }}
              />
            )}
          </div>
        ))}
      </div>
      {first && last && (
        <div className="mt-2 flex justify-between gap-4 text-xs text-[color:var(--fg-muted)]">
          <span>{axisLabel(first)}</span>
          {last !== first && <span>{axisLabel(last)}</span>}
        </div>
      )}
    </div>
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
  const { usd, compact } = useUsageFormatters();
  if (rows.length === 0) return <Empty />;
  // #1393 — a grouped row gets a readable name instead of its raw key.
  const rowLabel = (r: UsageByKey): string =>
    r.group === 'builder'
      ? t('groups.builder', { count: r.members ?? 1 })
      : r.group === 'other'
        ? t('groups.other', { count: r.members ?? 1 })
        : r.key;
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={`${r.group ?? 'key'}:${r.key}`}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium text-[color:var(--fg-strong)]" title={r.key}>
              {rowLabel(r)}
            </span>
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
              cacheRead: compact(r.cacheReadTokens),
              cacheWrite: compact(r.cacheCreationTokens),
            })}
            {/* #1393 — subscription calls bill $0; say what they would have
                cost. Worded as the subscription share, because a row can mix
                metered and subscription calls on one model id. */}
            {r.referenceCostUsd > 0 && t('rowReference', { reference: usd(r.referenceCostUsd) })}
          </div>
        </li>
      ))}
    </ul>
  );
}
