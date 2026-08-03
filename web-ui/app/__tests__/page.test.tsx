import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminProvider, ProvidersResponse } from '../_lib/api';

/**
 * Dashboard LLM-health derivation (OM-02/03/04).
 *
 * The tile used to report "LLM provider · CONNECTED · Active: Anthropic" purely
 * because a non-empty string sat in the vault, while every chat request failed
 * with `invalid x-api-key`. These tests pin the rule that replaced it: only a
 * PROBED provider counts as OK; a merely-stored key is a warning.
 *
 * `t` is stubbed to echo its key (plus params), so the assertions read as
 * "which message did the tile choose", independent of the catalog wording.
 */

const {
  mockGetProviders,
  mockListStorePlugins,
  mockListOperatorAgents,
  mockMcp,
  mockGetCliBackends,
} = vi.hoisted(() => ({
  mockGetProviders: vi.fn(),
  mockListStorePlugins: vi.fn(),
  mockListOperatorAgents: vi.fn(),
  mockMcp: vi.fn(),
  mockGetCliBackends: vi.fn(),
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

vi.mock('../_lib/api', () => ({
  getProviders: mockGetProviders,
  listStorePlugins: mockListStorePlugins,
  getCliBackends: mockGetCliBackends,
}));

vi.mock('../_lib/agents', () => ({
  listOperatorAgents: mockListOperatorAgents,
  getMcpServerSummary: mockMcp,
}));

vi.mock('../_lib/authRedirect', () => ({
  redirectIfUnauthorized: vi.fn(),
}));

vi.mock('../_components/dashboard/DashboardOnboarding', () => ({
  DashboardOnboarding: ({
    llmVerified,
    cliLoggedIn,
  }: {
    llmVerified: boolean;
    cliLoggedIn: boolean;
  }): React.ReactElement => (
    <div
      data-testid="onboarding"
      data-llm-verified={String(llmVerified)}
      data-cli-logged-in={String(cliLoggedIn)}
    />
  ),
}));

import DashboardPage from '../page';

function provider(over: Partial<AdminProvider> = {}): AdminProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    status: 'no_key',
    connected: false,
    models: [],
    ...over,
  };
}

function providersResponse(providers: AdminProvider[]): ProvidersResponse {
  return {
    providers,
    assignments: [
      {
        pluginId: '@omadia/orchestrator',
        label: 'Orchestrator',
        installed: true,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        modelKey: 'orchestrator_model',
      },
    ],
    vault_available: true,
  };
}

/** Render the dashboard and return the LLM health card's text content. */
async function renderLlmCard(providers: AdminProvider[]): Promise<string> {
  mockGetProviders.mockResolvedValue(providersResponse(providers));
  render(await DashboardPage());
  const title = screen.getByText('health.llm.title');
  const card = title.closest('li');
  if (!card) throw new Error('LLM health card not found');
  return card.textContent ?? '';
}

describe('dashboard — LLM health derivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListStorePlugins.mockResolvedValue({ items: [] });
    mockListOperatorAgents.mockResolvedValue({ agents: [] });
    mockMcp.mockResolvedValue({});
    mockGetCliBackends.mockResolvedValue({ backends: [], generatedAt: Date.now() });
  });

  it('a verified provider reads OK and names the active provider', async () => {
    const text = await renderLlmCard([
      provider({ status: 'verified', connected: true, verifiedAt: '2026-08-03T10:00:00Z' }),
    ]);
    expect(text).toContain('health.ok');
    expect(text).not.toContain('health.warn');
    expect(text).toContain('health.llm.active');
  });

  it('a stored-but-unverified key reads WARN, not OK — this is the bug', async () => {
    const text = await renderLlmCard([
      provider({ status: 'unverified', connected: true }),
    ]);
    expect(text).toContain('health.warn');
    expect(text).not.toContain('health.ok');
    expect(text).toContain('health.llm.unverified:{"count":1}');
    expect(text).not.toContain('health.llm.active');
  });

  it('a rejected key reads WARN and says so', async () => {
    const text = await renderLlmCard([
      provider({ status: 'invalid', connected: true, verifyError: 'nope' }),
    ]);
    expect(text).toContain('health.warn');
    expect(text).toContain('health.llm.invalid');
  });

  it('mixed verified + unverified still warns — a half-broken setup is not OK', async () => {
    const text = await renderLlmCard([
      provider({ status: 'verified', connected: true }),
      provider({ id: 'openai', label: 'OpenAI', status: 'unverified', connected: true }),
    ]);
    expect(text).toContain('health.warn');
    expect(text).toContain('health.llm.unverified:{"count":1}');
  });

  it('a rejected key outranks a verified one in the detail line', async () => {
    const text = await renderLlmCard([
      provider({ status: 'verified', connected: true }),
      provider({ id: 'openai', label: 'OpenAI', status: 'invalid', connected: true }),
    ]);
    expect(text).toContain('health.llm.invalid');
  });

  it('no providers at all reads WARN with the "none" message', async () => {
    const text = await renderLlmCard([]);
    expect(text).toContain('health.warn');
    expect(text).toContain('health.llm.none');
  });

  // OM-01/12 (Wave 5) — this assertion INVERTED on purpose. Onboarding used to
  // run on the looser `connected` test ("a key is on file"), which is exactly
  // the signal that rendered "VERBUNDEN" while every request failed with
  // `invalid x-api-key`. A step may only be ticked on a proved signal.
  it('a merely-stored key does NOT satisfy the onboarding LLM step', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse([provider({ status: 'unverified', connected: true })]),
    );
    render(await DashboardPage());
    expect(screen.getByTestId('onboarding').dataset['llmVerified']).toBe('false');
  });

  it('a verified key satisfies the onboarding LLM step', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse([provider({ status: 'verified', connected: true })]),
    );
    render(await DashboardPage());
    expect(screen.getByTestId('onboarding').dataset['llmVerified']).toBe('true');
  });

  it('onboarding is not satisfied when no key exists at all', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse([provider({ status: 'no_key', connected: false })]),
    );
    render(await DashboardPage());
    expect(screen.getByTestId('onboarding').dataset['llmVerified']).toBe('false');
  });

  // OM-01/12 item 5 — a locally authenticated subscription CLI is the only
  // other genuinely verified LLM signal, and the dashboard ignored it. It also
  // covers the offline/air-gapped case that the old looser test existed for.
  it('a logged-in subscription CLI satisfies the onboarding LLM step', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse([provider({ status: 'no_key', connected: false })]),
    );
    mockGetCliBackends.mockResolvedValue({
      backends: [
        {
          id: 'claude',
          label: 'Claude',
          bin: 'claude',
          installed: true,
          loggedIn: 'yes',
          billing: 'subscription',
          detail: 'Logged in.',
        },
      ],
      generatedAt: Date.now(),
    });
    render(await DashboardPage());
    expect(screen.getByTestId('onboarding').dataset['cliLoggedIn']).toBe('true');
  });
});
