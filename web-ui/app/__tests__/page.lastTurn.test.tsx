import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LastTurnOutcome, ProvidersResponse } from '../_lib/api';

/**
 * OM-100b / #1077 — the dashboard's "last turn" card and its effect on the
 * two cards above it.
 *
 * Every other status card answers a configuration question; this one asks
 * whether a turn actually came back. `page.test.tsx` never mocked
 * `getLastTurn`, so the card only ever rendered its `null` state and none of
 * the outcomes below ran in CI. Kept in its own file because the dashboard
 * suite is already near the size limit; the mock scaffolding mirrors it.
 *
 * `t` is stubbed to echo its key (plus params), so assertions read as "which
 * message did the card choose", independent of the catalog wording.
 */

const {
  mockGetProviders,
  mockListStorePlugins,
  mockListOperatorAgents,
  mockMcp,
  mockGetCliBackends,
  mockGetEmbeddingStatus,
  mockGetLastTurn,
} = vi.hoisted(() => ({
  mockGetProviders: vi.fn(),
  mockListStorePlugins: vi.fn(),
  mockListOperatorAgents: vi.fn(),
  mockMcp: vi.fn(),
  mockGetCliBackends: vi.fn(),
  mockGetEmbeddingStatus: vi.fn(),
  mockGetLastTurn: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: async () =>
    (key: string, params?: Record<string, unknown>): string =>
      params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }): React.ReactElement => <a href={href}>{children}</a>,
}));

vi.mock('../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/api')>()),
  getProviders: mockGetProviders,
  listStorePlugins: mockListStorePlugins,
  getCliBackends: mockGetCliBackends,
  getEmbeddingProviderStatus: mockGetEmbeddingStatus,
  getLastTurn: mockGetLastTurn,
}));

vi.mock('../_lib/agents', () => ({
  listOperatorAgents: mockListOperatorAgents,
  getMcpServerSummary: mockMcp,
}));

vi.mock('../_lib/authRedirect', () => ({
  redirectIfUnauthorized: vi.fn(),
}));

vi.mock('../_components/dashboard/DashboardOnboarding', () => ({
  DashboardOnboarding: (): React.ReactElement => <div data-testid="onboarding" />,
}));

import DashboardPage from '../page';

/** A healthy baseline: one verified provider, one agent. Every card above the
 *  last-turn card reads OK until a failed turn says otherwise. */
const PROVIDERS: ProvidersResponse = {
  providers: [
    {
      id: 'claude-cli',
      label: 'Claude subscription',
      status: 'verified',
      connected: true,
      models: [],
    },
  ],
  assignments: [
    {
      pluginId: '@omadia/orchestrator',
      label: 'Orchestrator',
      installed: true,
      provider: 'claude-cli',
      model: 'opus-cli',
      modelKey: 'orchestrator_model',
    },
  ],
  vault_available: true,
};

interface Card {
  readonly text: string;
  readonly href: string | null;
}

function card(titleKey: string): Card {
  const li = screen.getByText(titleKey).closest('li');
  if (!li) throw new Error(`${titleKey} card not found`);
  return {
    text: li.textContent ?? '',
    href: li.querySelector('a')?.getAttribute('href') ?? null,
  };
}

async function renderWithLastTurn(lastTurn: LastTurnOutcome | null): Promise<void> {
  mockGetLastTurn.mockResolvedValue({ lastTurn });
  render(await DashboardPage());
}

const failed = (over: Partial<LastTurnOutcome>): LastTurnOutcome => ({
  status: 'failed',
  at: Date.parse('2026-09-20T10:00:00Z'),
  ...over,
});

describe('dashboard — last-turn card (OM-100b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProviders.mockResolvedValue(PROVIDERS);
    mockListStorePlugins.mockResolvedValue({ items: [] });
    // Resolving keeps the runtime "up" (#1179's middleware-down gate would
    // otherwise turn every card to `down` and mask the outcome under test).
    mockListOperatorAgents.mockResolvedValue({ agents: [{ id: 'a1' }] });
    mockMcp.mockResolvedValue({});
    mockGetCliBackends.mockResolvedValue({ backends: [], generatedAt: Date.now() });
    mockGetEmbeddingStatus.mockResolvedValue({
      capabilityPublished: true,
      activeProviderId: '@omadia/embeddings',
      activeModel: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
      installedProviderIds: ['@omadia/embeddings'],
    });
  });

  it('says "unknown" rather than OK when no turn has run yet', async () => {
    await renderWithLastTurn(null);
    const { text, href } = card('health.lastTurn.title');
    expect(text).toContain('health.lastTurn.unknownStatus');
    expect(text).toContain('health.lastTurn.none');
    expect(text).not.toContain('health.lastTurn.okStatus');
    expect(href).toBe('/admin/providers');
    // No evidence against the cards above — they keep their own verdict.
    expect(card('health.llm.title').text).toContain('health.ok');
  });

  it('reads OK after a turn that came back', async () => {
    await renderWithLastTurn({ status: 'ok', at: Date.now() });
    const { text } = card('health.lastTurn.title');
    expect(text).toContain('health.lastTurn.okStatus');
    expect(text).toContain('health.lastTurn.ok');
    expect(card('health.orchestrators.title').text).toContain('health.ok');
  });

  it('names both CLI versions for an incompatible CLI', async () => {
    await renderWithLastTurn(
      failed({ errorCode: 'cli_incompatible', cliVersion: '2.1.100', minCliVersion: '2.1.248' }),
    );
    const { text } = card('health.lastTurn.title');
    expect(text).toContain('health.warn');
    expect(text).toContain(
      'health.lastTurn.cliIncompatible:{"installed":"2.1.100","required":"2.1.248"}',
    );
  });

  it('says "unknown version" when the CLI version could not be read', async () => {
    await renderWithLastTurn(failed({ errorCode: 'cli_incompatible', minCliVersion: '2.1.248' }));
    expect(card('health.lastTurn.title').text).toContain(
      'health.lastTurn.cliIncompatible:{"installed":"health.lastTurn.unknownVersion","required":"2.1.248"}',
    );
  });

  it('sends a timed-out turn to the subscription tab, where the budget lives', async () => {
    await renderWithLastTurn(failed({ errorCode: 'cli_timeout', errorMessage: 'CLI timed out' }));
    const { text, href } = card('health.lastTurn.title');
    expect(text).toContain('health.lastTurn.cliTimeout');
    expect(text).not.toContain('CLI timed out');
    expect(href).toBe('/admin/providers?tab=subscriptions');
  });

  it('falls back to the error’s own message for any other failure', async () => {
    await renderWithLastTurn(
      failed({ errorCode: 'orchestrator_failure', errorMessage: 'upstream 500' }),
    );
    const { text, href } = card('health.lastTurn.title');
    expect(text).toContain('health.lastTurn.failure:{"message":"upstream 500"}');
    expect(href).toBe('/admin/providers');
  });

  it('a failed turn drops the LLM and orchestrator cards to "needs attention"', async () => {
    await renderWithLastTurn(failed({ errorCode: 'orchestrator_failure', errorMessage: 'x' }));
    // Credential present and agent configured — neither survived a real turn.
    for (const title of ['health.llm.title', 'health.orchestrators.title']) {
      const { text } = card(title);
      expect(text, title).toContain('health.warn');
      expect(text, title).not.toContain('health.ok');
    }
  });
});
