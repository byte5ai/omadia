/**
 * USD → EUR for the cost dashboard, from the ECB's daily euro reference rates.
 *
 * The ledger stays in USD (provider prices are USD); the EUR figure is a
 * presentation, and it says which rate it used: the response carries the
 * ECB's publication date next to the rate, so the page can name it instead of
 * presenting a converted number as a ledger figure (#679 / I6).
 *
 * The ECB publishes once per working day around 16:00 CET. A fetched rate is
 * reused for {@link FRESH_MS}; when a refresh fails, the last good rate keeps
 * being served (its date shows how old it is) and the next attempt waits
 * {@link RETRY_MS}, so an offline install does not pay a timeout per page
 * load. With no rate at all the source returns `null` and the page stays USD.
 */

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

/** How long a fetched rate is served before a refresh is attempted. */
const FRESH_MS = 6 * 60 * 60 * 1000;
/** How long after a failed refresh the next attempt waits. */
const RETRY_MS = 10 * 60 * 1000;
/** Upper bound on one ECB request; the dashboard must not hang on it. */
const FETCH_TIMEOUT_MS = 4000;

export interface FxRate {
  /** Euros per US dollar, e.g. 0.92. */
  readonly eurPerUsd: number;
  /** The ECB publication date of the rate, `YYYY-MM-DD`. */
  readonly date: string;
  readonly source: 'ECB';
}

type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

interface EcbRateSourceOptions {
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

/**
 * Parses the ECB daily XML. It quotes USD per EUR (`rate='1.0812'`); the
 * dashboard multiplies USD amounts, so this returns the inverse. Throws on a
 * document without a plausible USD rate or date — never guesses one.
 */
export function parseEcbDailyXml(xml: string): FxRate {
  const usd = /currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]/.exec(xml);
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml);
  const usdPerEur = usd ? Number(usd[1]) : NaN;
  if (!date || !Number.isFinite(usdPerEur) || usdPerEur <= 0) {
    throw new Error('ECB response has no USD rate');
  }
  return { eurPerUsd: 1 / usdPerEur, date: date[1]!, source: 'ECB' };
}

/**
 * A cached EUR-rate source. Never throws: a failure is logged and answered
 * with the last good rate, or `null` when there never was one.
 */
export function createEcbEurRateSource(opts: EcbRateSourceOptions = {}): () => Promise<FxRate | null> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  let cached: FxRate | null = null;
  let nextAttemptAt = 0;
  let inflight: Promise<FxRate | null> | null = null;

  const refresh = async (): Promise<FxRate | null> => {
    try {
      const res = await fetchImpl(ECB_DAILY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cached = parseEcbDailyXml(await res.text());
      nextAttemptAt = now() + FRESH_MS;
    } catch (err) {
      nextAttemptAt = now() + RETRY_MS;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[usage-telemetry] ECB exchange rate unavailable (${message}) — ` +
          (cached ? `serving rate of ${cached.date}` : 'dashboard stays in USD'),
      );
    }
    return cached;
  };

  return async () => {
    if (now() < nextAttemptAt) return cached;
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
