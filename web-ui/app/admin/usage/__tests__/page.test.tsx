import { screen } from '@testing-library/react';
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

function dashboard(totals: Totals): unknown {
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
    expect(url).toMatch(/^\/bot-api\/usage\/dashboard\?bucket=hour&since=/);
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
