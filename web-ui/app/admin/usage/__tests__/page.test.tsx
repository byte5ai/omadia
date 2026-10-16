import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import UsageDashboardPage from '../page';

/**
 * OM-103 / #1077 — the subscription block on ADMIN → Usage & cost.
 *
 * An operator running purely on a Claude subscription read "0 calls" here.
 * Subscription turns now reach the ledger with `cost_usd = 0` and the vendor's
 * figure in `referenceCostUsd`; this page states them on their own line, never
 * inside the billed total. Only `fetch` is stubbed — the page is rendered for
 * real, so dropping the block or its reference-cost interpolation goes red.
 */

interface Totals {
  calls: number;
  costUsd: number;
  referenceCostUsd: number;
  subscriptionCalls: number;
}

function dashboard(totals: Totals, rest: Record<string, unknown> = {}): unknown {
  return {
    totals: {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
      cacheCreationTokens: 64,
      cacheHitRatio: 0.4,
      ...totals,
    },
    byModel: [],
    bySource: [],
    timeSeries: [],
    ...rest,
  };
}

const METERED: Totals = { calls: 5, costUsd: 2.5, referenceCostUsd: 0, subscriptionCalls: 0 };

function byKey(key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    calls: 3,
    costUsd: 1.3,
    referenceCostUsd: 0,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheCreationTokens: 208000,
    ...extra,
  };
}

const fetchMock = vi.fn();

function respondWith(body: unknown, status = 200): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('ADMIN → Usage & cost page', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('states subscription turns and their reference cost on their own line', async () => {
    respondWith(
      dashboard({ calls: 12, costUsd: 0, referenceCostUsd: 0.0421, subscriptionCalls: 12 }),
    );
    renderWithIntl(<UsageDashboardPage />);

    expect(await screen.findByText('12 subscription turns in this window')).toBeInTheDocument();
    expect(screen.getByText(/On the metered API they would have cost \$0\.0421\./)).toBeInTheDocument();
    // The billed total stays at zero; the reference figure is not folded in.
    expect(screen.getByText('Total cost').nextSibling).toHaveTextContent('$0.00');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^\/bot-api\/usage\/dashboard\?bucket=hour&tz=UTC&since=/);
    expect(init.credentials).toBe('include');
  });

  it('uses the singular for one subscription turn', async () => {
    respondWith(dashboard({ calls: 3, costUsd: 1.5, referenceCostUsd: 0.01, subscriptionCalls: 1 }));
    renderWithIntl(<UsageDashboardPage />);
    expect(await screen.findByText('1 subscription turn in this window')).toBeInTheDocument();
  });

  it('shows no subscription block when every call was metered', async () => {
    respondWith(dashboard({ calls: 5, costUsd: 2.5, referenceCostUsd: 0, subscriptionCalls: 0 }));
    renderWithIntl(<UsageDashboardPage />);

    expect(await screen.findByText('Total cost')).toBeInTheDocument();
    expect(screen.queryByText(/subscription turn/)).not.toBeInTheDocument();
    expect(screen.queryByText(/On the metered API/)).not.toBeInTheDocument();
  });

  it('reports a failed load instead of rendering an empty dashboard', async () => {
    respondWith({}, 503);
    renderWithIntl(<UsageDashboardPage />);
    expect(await screen.findByText('Failed to load: HTTP 503')).toBeInTheDocument();
    expect(screen.queryByText('Total cost')).not.toBeInTheDocument();
  });

  it('#1396 — sends the configured zone and asks for whole local days', async () => {
    respondWith(dashboard(METERED));
    renderWithIntl(<UsageDashboardPage />, { timeZone: 'Europe/Berlin' });
    await screen.findByText('Total cost');

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url] = fetchMock.mock.calls[1] as [string];
    const params = new URL(url, 'http://x').searchParams;
    expect(params.get('bucket')).toBe('day');
    expect(params.get('tz')).toBe('Europe/Berlin');
    // 5.5 days back; the middleware floors that to local midnight, so the
    // range is today plus six whole days, DST shift or not.
    const back = Date.now() - new Date(params.get('since')!).getTime();
    expect(back).toBeGreaterThan(5.5 * 86_400_000 - 60_000);
    expect(back).toBeLessThan(5.5 * 86_400_000 + 60_000);
  });

  it('#1388 — renders bars that span the chart height, with an axis and no bar for idle buckets', async () => {
    respondWith(
      dashboard(METERED, {
        timeSeries: [
          { bucket: '2026-10-07T10:00:00.000Z', costUsd: 3.24, calls: 76 },
          { bucket: '2026-10-07T11:00:00.000Z', costUsd: 0, calls: 0 },
          { bucket: '2026-10-07T12:00:00.000Z', costUsd: 1.62, calls: 10 },
        ],
      }),
    );
    renderWithIntl(<UsageDashboardPage />);

    const chart = await screen.findByTestId('cost-chart');
    const buckets = Array.from(chart.children) as HTMLElement[];
    expect(buckets).toHaveLength(3);
    // jsdom has no layout engine: pin the class that gives each bucket a
    // definite height, without which every bar computed to 0 px.
    for (const b of buckets) expect(b.className).toMatch(/\bh-full\b/);
    expect((buckets[0]!.firstElementChild as HTMLElement).style.height).toBe('100%');
    expect((buckets[2]!.firstElementChild as HTMLElement).style.height).toBe('50%');
    expect(buckets[1]!.childElementCount).toBe(0);
    expect(buckets[0]!.title).toBe('Oct 7, 2026, 10:00 AM · $3.24 · 76 calls');
    // Axis: first and last bucket.
    expect(screen.getByText('Oct 7, 2026, 10:00 AM')).toBeInTheDocument();
    expect(screen.getByText('Oct 7, 2026, 12:00 PM')).toBeInTheDocument();
  });

  it('#1396 — labels a daily bucket with its date only', async () => {
    respondWith(
      dashboard(METERED, {
        timeSeries: [{ bucket: '2026-10-06T22:00:00.000Z', costUsd: 3.24, calls: 76 }],
      }),
    );
    renderWithIntl(<UsageDashboardPage />, { timeZone: 'Europe/Berlin' });
    await screen.findByTestId('cost-chart');
    respondWith(
      dashboard(METERED, {
        timeSeries: [{ bucket: '2026-10-06T22:00:00.000Z', costUsd: 3.24, calls: 76 }],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));

    await vi.waitFor(() => {
      const bucket = screen.getByTestId('cost-chart').firstElementChild as HTMLElement;
      // Local midnight in Berlin, shown as a date with no time of day.
      expect(bucket.title).toBe('Oct 7, 2026 · $3.24 · 76 calls');
    });
  });

  it('#1388 — shows the empty state when every bucket is idle', async () => {
    respondWith(
      dashboard(METERED, {
        timeSeries: [
          { bucket: '2026-10-07T10:00:00.000Z', costUsd: 0, calls: 0 },
          { bucket: '2026-10-07T11:00:00.000Z', costUsd: 0, calls: 0 },
        ],
      }),
    );
    renderWithIntl(<UsageDashboardPage />);
    expect(await screen.findAllByText('No data in this period.')).not.toHaveLength(0);
    expect(screen.queryByTestId('cost-chart')).not.toBeInTheDocument();
  });

  it('#1393 — a breakdown row shows cache writes, the reference cost and grouped names', async () => {
    respondWith(
      dashboard(METERED, {
        byModel: [
          byKey('claude-opus-5'),
          byKey('claude-cli', { costUsd: 0, referenceCostUsd: 0.0219, cacheCreationTokens: 0 }),
        ],
        bySource: [
          byKey('sub-agent builder', { group: 'builder', members: 3 }),
          byKey('other', { group: 'other', members: 4 }),
        ],
      }),
    );
    renderWithIntl(<UsageDashboardPage />);

    const opus = (await screen.findByText('claude-opus-5')).closest('li')!;
    expect(within(opus).getByText(/5K cache read · 208K cache write/)).toBeInTheDocument();

    const cli = screen.getByText('claude-cli').closest('li')!;
    expect(within(cli).getByText(/· subscription calls ≈ \$0\.0219 API equivalent/)).toBeInTheDocument();
    expect(within(opus).queryByText(/API equivalent/)).not.toBeInTheDocument();

    expect(screen.getByText('Builder (3 drafts)')).toBeInTheDocument();
    expect(screen.getByText('Other (4 sources)')).toBeInTheDocument();
    expect(screen.queryByText('sub-agent builder')).not.toBeInTheDocument();
  });

  it('renders the German catalog too', async () => {
    respondWith(
      dashboard({ calls: 2, costUsd: 0, referenceCostUsd: 0.5, subscriptionCalls: 2 }),
    );
    renderWithIntl(<UsageDashboardPage />, { locale: 'de' });
    // Both keys exist in de.json and interpolate their arguments.
    const headline = await screen.findByText(/^2 /);
    expect(headline.textContent).not.toMatch(/\{count/);
    expect(screen.getByText(/0,5000\s\$/)).toBeInTheDocument();
  });
});
