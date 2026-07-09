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

const TITLE_DE = 'LLM-API-Key fehlt';

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
