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

  it('stays silent on a 503 without the structured error code', async () => {
    respondWith(503, { error: 'something_else' });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();

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

  // OM-72 (#1002) / OM-75 — the body must not promise "sofort verfügbar" nor
  // point at a middleware restart the UI does not offer.
  it('does not promise instant availability or a restart control', async () => {
    respondWith(503, { error: 'multi_orchestrator_unavailable' });
    renderWithIntl(<RuntimeReadinessBanner />, { locale: 'de' });
    await flush();

    const card = screen.getByTestId('runtime-readiness-card');
    expect(card.textContent).not.toMatch(/sofort verfügbar/);
    expect(card.textContent).not.toMatch(/Neustart der Middleware/);
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
