import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { RuntimeReadinessBanner } from '../RuntimeReadinessBanner';

/**
 * Coverage for the fresh-install readiness card: it must appear exactly
 * when the operator probe answers the structured 503
 * (`multi_orchestrator_unavailable` — no LLM key / orchestrator down),
 * stay silent for every other response, and clear itself once a later
 * heartbeat sees the runtime come up.
 */

const TITLE_DE = 'LLM-Zugang fehlt';
const TITLE_UNREACHABLE_DE = 'Runtime-Status unbekannt';

const { mockUsePathname } = vi.hoisted(() => ({
  mockUsePathname: vi.fn(() => '/'),
}));

vi.mock('next/navigation', () => ({ usePathname: mockUsePathname }));

const mockFetch = vi.fn();

function respondWith(status: number, body: unknown): void {
  mockFetch.mockResolvedValue({
    status,
    json: () => Promise.resolve(body),
  });
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockUsePathname.mockReturnValue('/');
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('<RuntimeReadinessBanner />', () => {
  it('shows the card on the structured orchestrator-unavailable 503', async () => {
    respondWith(503, { error: 'multi_orchestrator_unavailable' });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();

    expect(screen.getByText(TITLE_DE)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /LLM-Zugang öffnen/i }),
    ).toHaveAttribute('href', '/admin/providers');
    expect(mockFetch).toHaveBeenCalledWith(
      '/bot-api/v1/operator/agents',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('stays silent when the runtime is up (200)', async () => {
    respondWith(200, { agents: [] });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();

    expect(screen.queryByText(TITLE_DE)).not.toBeInTheDocument();
  });

  /**
   * #1088 — a 503 that is NOT the middleware's own structured verdict is a
   * gateway sentence: in the stock stack it is what sits in front of a dead
   * container. It used to clear the card ("not this card's concern"); it now
   * reports the backend as unreachable, without borrowing the access copy.
   */
  it('reports unreachable on a 503 without the structured error code', async () => {
    respondWith(503, { error: 'something_else' });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();

    expect(screen.getByText(TITLE_UNREACHABLE_DE)).toBeInTheDocument();
    expect(screen.queryByText(TITLE_DE)).not.toBeInTheDocument();
  });

  it('stays silent when unauthenticated (401) — not this card’s concern', async () => {
    respondWith(401, { error: 'unauthorized' });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();

    expect(screen.queryByText(TITLE_DE)).not.toBeInTheDocument();
  });

  it('does not probe at all on the auth pages', async () => {
    mockUsePathname.mockReturnValue('/login');
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // OM-75 (#1000) — two causes, two texts. The tester had a working
  // subscription login and was still told to "add a key or subscription".
  it('names the missing assignment when the 503 says cause=no_assignment', async () => {
    respondWith(503, {
      error: 'multi_orchestrator_unavailable',
      cause: 'no_assignment',
    });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();

    expect(screen.getByText('Orchestrator nicht zugeordnet')).toBeInTheDocument();
    expect(screen.queryByText(TITLE_DE)).not.toBeInTheDocument();
    expect(screen.getByText(/keinem Provider mit Zugang zugeordnet/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Zuordnung öffnen/i }),
    ).toHaveAttribute('href', '/admin/providers');
    expect(screen.getByTestId('runtime-readiness-card').dataset['cause']).toBe(
      'no_assignment',
    );
  });

  it('keeps the access copy for cause=no_llm_access and for a 503 without a cause', async () => {
    respondWith(503, {
      error: 'multi_orchestrator_unavailable',
      cause: 'no_llm_access',
    });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();

    expect(screen.getByText(TITLE_DE)).toBeInTheDocument();
    expect(screen.queryByText('Orchestrator nicht zugeordnet')).not.toBeInTheDocument();
  });

  // `unknown` is derived as "access AND assignment are set" — e.g. an invalid
  // key. Telling that operator no key is stored would be false.
  it('does not claim a missing access when the 503 says cause=unknown', async () => {
    respondWith(503, {
      error: 'multi_orchestrator_unavailable',
      cause: 'unknown',
    });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();

    expect(screen.getByText('Agent-Runtime antwortet nicht')).toBeInTheDocument();
    expect(screen.queryByText(TITLE_DE)).not.toBeInTheDocument();
    const card = screen.getByTestId('runtime-readiness-card');
    expect(card.dataset['cause']).toBe('unknown');
    expect(card.textContent).toMatch(/Zugang und Zuordnung sind gesetzt/);
    expect(card.textContent).not.toMatch(/kein LLM-API-Key/);
    expect(
      screen.getByRole('link', { name: /LLM-Zugang öffnen/i }),
    ).toHaveAttribute('href', '/admin/providers');
  });

  // OM-72 (#1002) / OM-75 — the body must not promise "sofort verfügbar" nor
  // point at a middleware restart the UI does not offer. Both locales.
  it('does not promise instant availability or a restart control (de)', async () => {
    respondWith(503, { error: 'multi_orchestrator_unavailable' });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();

    const card = screen.getByTestId('runtime-readiness-card');
    expect(card.textContent).not.toMatch(/sofort verfügbar/);
    expect(card.textContent).not.toMatch(/Neustart der Middleware/);
  });

  it('does not promise instant availability or a restart control (en)', async () => {
    respondWith(503, { error: 'multi_orchestrator_unavailable' });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'en' });
    await flush();

    const card = screen.getByTestId('runtime-readiness-card');
    expect(card.textContent).not.toMatch(/right away/);
    expect(card.textContent).not.toMatch(/middleware restart/i);
  });

  /**
   * #1088 — the outage case the card was built for and then hid. With the
   * middleware container down, `/bot-api/*` answers 5xx (web-ui's own proxy
   * route throws → 500; a reverse proxy in front → 502), or the fetch throws
   * outright. The old probe cleared the card for every `status !== 503` and
   * swallowed the throw, so the one card whose job is to say the runtime
   * cannot serve agents disappeared exactly when it was true.
   */
  describe('#1088 — a middleware that does not answer', () => {
    it.each([500, 502, 504])('shows the unreachable card on a proxy %i', async (status) => {
      respondWith(status, null);
      renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
      await flush();

      const card = screen.getByTestId('runtime-readiness-card');
      expect(card.dataset['cause']).toBe('unreachable');
      expect(screen.getByText(TITLE_UNREACHABLE_DE)).toBeInTheDocument();
    });

    it('shows the unreachable card when the fetch itself throws', async () => {
      mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
      renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
      await flush();

      expect(screen.getByTestId('runtime-readiness-card').dataset['cause']).toBe(
        'unreachable',
      );
    });

    /**
     * The `unknown` copy asserts "access and assignment are set" — the one
     * thing a middleware that never answered cannot tell us — and its CTA
     * leads to the provider page, which is not where a stopped container is
     * fixed.
     */
    it('does not borrow the unknown-cause copy or its CTA', async () => {
      respondWith(502, null);
      renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
      await flush();

      const card = screen.getByTestId('runtime-readiness-card');
      expect(card.textContent).not.toMatch(/Zugang und Zuordnung sind gesetzt/);
      expect(card.textContent).not.toMatch(/kein LLM-API-Key/);
      expect(
        screen.getByRole('link', { name: /Update & Status öffnen/i }),
      ).toHaveAttribute('href', '/admin/update');
    });

    /**
     * The card's copy must survive the health tile next to it: `middlewareOk`
     * (app/page.tsx) is true as soon as ANY call came back, and a live
     * middleware can still answer 500 from this one handler. So the text may
     * not assert that the container is stopped.
     */
    it.each([
      ['de', /Möglicherweise/],
      ['en', /may be/],
    ])('does not assert the container is down (%s)', async (locale, hedge) => {
      respondWith(500, null);
      renderWithIntl(<RuntimeReadinessBanner />, { locale: locale as 'de' | 'en' });
      await flush();

      const card = screen.getByTestId('runtime-readiness-card');
      expect(card.textContent).toMatch(hedge);
      expect(card.textContent).not.toMatch(/Crash-Schleife|crash-looping/);
    });

    /**
     * The dismissal is keyed to the CAUSE. A transport failure can now raise
     * the card, so a plain boolean would let one waved-away blip swallow every
     * later cause — including a real `no_llm_access` 503 — for the rest of the
     * session.
     */
    it('a dismissed blip does not suppress a later, different cause', async () => {
      mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
      renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
      await flush();

      await act(async () => {
        screen.getByRole('button', { name: /Später/i }).click();
      });
      expect(screen.queryByTestId('runtime-readiness-card')).not.toBeInTheDocument();

      // The backend comes back and reports the real problem.
      respondWith(503, { error: 'multi_orchestrator_unavailable' });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText(TITLE_DE)).toBeInTheDocument();
    });

    it('keeps the same cause dismissed', async () => {
      respondWith(502, null);
      renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
      await flush();

      await act(async () => {
        screen.getByRole('button', { name: /Später/i }).click();
      });

      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.queryByTestId('runtime-readiness-card')).not.toBeInTheDocument();
    });

    it('re-arms the dismissal once the card has cleared — a new outage is a new event', async () => {
      respondWith(502, null);
      renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
      await flush();
      await act(async () => {
        screen.getByRole('button', { name: /Später/i }).click();
      });

      // The middleware comes back …
      respondWith(200, { agents: [] });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });

      // … and falls over again later. The operator dismissed the earlier
      // outage, not this one.
      respondWith(502, null);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText(TITLE_UNREACHABLE_DE)).toBeInTheDocument();
    });

    /**
     * Two probes can be in flight (heartbeat + tab focus). Only reachable now
     * that a rejection writes state: a slow failure landing AFTER a newer
     * success must not resurrect the card against a healthy backend.
     */
    it('a stale rejection does not resurrect the card after a newer success', async () => {
      let failSlowProbe = (): void => {};
      const slow = new Promise((_resolve, reject) => {
        failSlowProbe = () => reject(new TypeError('Failed to fetch'));
      });
      mockFetch.mockReturnValueOnce(slow);
      renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
      await flush();

      // A second probe starts and succeeds while the first is still hanging.
      respondWith(200, { agents: [] });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });

      failSlowProbe();
      await flush();

      // Two observables, because the card alone is not enough: raising it
      // flips `visible`, which re-arms the effect and fires a THIRD probe that
      // clears the card again within the same tick. Without the generation
      // guard the operator still sees a flash and the app pays for an extra
      // round-trip, so pin the probe count too.
      expect(screen.queryByTestId('runtime-readiness-card')).not.toBeInTheDocument();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('clears itself once the middleware answers again', async () => {
      mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
      renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
      await flush();
      expect(screen.getByText(TITLE_UNREACHABLE_DE)).toBeInTheDocument();

      respondWith(200, { agents: [] });
      await flush(60 * 1000);

      expect(screen.queryByText(TITLE_UNREACHABLE_DE)).not.toBeInTheDocument();
    });
  });

  it('clears itself once a heartbeat sees the runtime come up', async () => {
    respondWith(503, { error: 'multi_orchestrator_unavailable' });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();
    expect(screen.getByText(TITLE_DE)).toBeInTheDocument();

    // Key gets saved → the same probe now answers 200.
    respondWith(200, { agents: [] });
    await flush(60 * 1000);

    expect(screen.queryByText(TITLE_DE)).not.toBeInTheDocument();
  });
});
