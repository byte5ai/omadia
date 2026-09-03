import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type AdminProvider, type ProvidersResponse } from '../_lib/api';

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
  mockGetEmbeddingStatus,
} = vi.hoisted(() => ({
  mockGetProviders: vi.fn(),
  mockListStorePlugins: vi.fn(),
  mockListOperatorAgents: vi.fn(),
  mockMcp: vi.fn(),
  mockGetCliBackends: vi.fn(),
  mockGetEmbeddingStatus: vi.fn(),
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

// `ApiError` stays real: page.tsx narrows the operator-agents rejection with
// `instanceof ApiError` to tell the structured 503 from any other failure.
vi.mock('../_lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/api')>()),
  getProviders: mockGetProviders,
  listStorePlugins: mockListStorePlugins,
  getCliBackends: mockGetCliBackends,
  getEmbeddingProviderStatus: mockGetEmbeddingStatus,
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
    runtimeUp,
    assignedProviderKind,
    assignedProviderStatus,
    assignedProviderLabel,
    embeddingsOff,
  }: {
    llmVerified: boolean;
    cliLoggedIn: boolean;
    runtimeUp: boolean;
    assignedProviderKind: 'cli' | 'oauth' | 'api' | null;
    assignedProviderStatus: string | null;
    assignedProviderLabel: string | null;
    embeddingsOff: boolean;
  }): React.ReactElement => (
    <div
      data-testid="onboarding"
      data-llm-verified={String(llmVerified)}
      data-cli-logged-in={String(cliLoggedIn)}
      data-runtime-up={String(runtimeUp)}
      data-assigned-kind={String(assignedProviderKind)}
      data-assigned-status={String(assignedProviderStatus)}
      data-assigned-label={String(assignedProviderLabel)}
      data-embeddings-off={String(embeddingsOff)}
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
    mockGetEmbeddingStatus.mockResolvedValue({
      capabilityPublished: true,
      activeProviderId: '@omadia/embeddings',
      activeModel: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
      installedProviderIds: ['@omadia/embeddings'],
    });
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

  // OM-78 (#1001) — the runtime signal handed to onboarding is the operator
  // route's answer, the same probe the readiness banner uses. A 503 there
  // means "not up", whatever the provider list says.
  it('OM-78: runtimeUp follows /operator/agents, not the provider list', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse([provider({ status: 'verified', connected: true })]),
    );
    mockListOperatorAgents.mockRejectedValue(
      new ApiError(503, 'GET /v1/operator/agents failed: 503', '{"error":"multi_orchestrator_unavailable"}'),
    );
    render(await DashboardPage());
    const onboarding = screen.getByTestId('onboarding').dataset;
    expect(onboarding['llmVerified']).toBe('true');
    expect(onboarding['runtimeUp']).toBe('false');
  });

  it('OM-78: runtimeUp is true once the operator route answers', async () => {
    mockGetProviders.mockResolvedValue(providersResponse([provider()]));
    render(await DashboardPage());
    expect(screen.getByTestId('onboarding').dataset['runtimeUp']).toBe('true');
  });

  it('OM-78: a transient 500 (or a network blip) does not un-tick step 1 — only the structured 503 does', async () => {
    mockGetProviders.mockResolvedValue(providersResponse([provider()]));
    mockListOperatorAgents.mockRejectedValue(
      new ApiError(500, 'GET /v1/operator/agents failed: 500'),
    );
    render(await DashboardPage());
    expect(screen.getByTestId('onboarding').dataset['runtimeUp']).toBe('true');

    cleanup();
    mockListOperatorAgents.mockRejectedValue(new TypeError('fetch failed'));
    render(await DashboardPage());
    expect(screen.getByTestId('onboarding').dataset['runtimeUp']).toBe('true');
  });

  // OM-74 (#999) — the done-copy follows what the orchestrator is ASSIGNED to.
  it('OM-74: a claude-cli assignment is reported as kind=cli', async () => {
    mockGetProviders.mockResolvedValue({
      ...providersResponse([
        provider({ id: 'claude-cli', label: 'Claude (subscription CLI)', toolLess: true }),
        provider(),
      ]),
      assignments: [
        {
          pluginId: '@omadia/orchestrator',
          label: 'Orchestrator',
          installed: true,
          provider: 'claude-cli',
          model: 'claude-cli:opus-cli',
          modelKey: 'orchestrator_model',
        },
      ],
    });
    render(await DashboardPage());
    expect(screen.getByTestId('onboarding').dataset['assignedKind']).toBe('cli');
  });

  it('OM-74: an anthropic assignment is reported as kind=api with its status and label', async () => {
    mockGetProviders.mockResolvedValue(
      providersResponse([provider({ status: 'unverified', connected: true })]),
    );
    render(await DashboardPage());
    const onboarding = screen.getByTestId('onboarding').dataset;
    expect(onboarding['assignedKind']).toBe('api');
    expect(onboarding['assignedStatus']).toBe('unverified');
    expect(onboarding['assignedLabel']).toBe('Anthropic');
  });

  it('OM-74: an OAuth subscription assignment is reported as kind=oauth', async () => {
    mockGetProviders.mockResolvedValue({
      ...providersResponse([
        provider({ id: 'openai-chatgpt', label: 'ChatGPT', oauthConnect: true, status: 'verified' }),
      ]),
      assignments: [
        {
          pluginId: '@omadia/orchestrator',
          label: 'Orchestrator',
          installed: true,
          provider: 'openai-chatgpt',
          model: 'openai-chatgpt:gpt-5',
          modelKey: 'orchestrator_model',
        },
      ],
    });
    render(await DashboardPage());
    expect(screen.getByTestId('onboarding').dataset['assignedKind']).toBe('oauth');
  });

  it('OM-74: no matching provider row reports kind=null, not api', async () => {
    mockGetProviders.mockResolvedValue({
      ...providersResponse([]),
    });
    render(await DashboardPage());
    const onboarding = screen.getByTestId('onboarding').dataset;
    expect(onboarding['assignedKind']).toBe('null');
    expect(onboarding['assignedStatus']).toBe('null');
  });
});

// OM-84 (#1003) — memory, semantic search and dedup hang off embeddingClient@1.
// A default install has none, and no surface said so.
describe('dashboard — embeddings health card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProviders.mockResolvedValue(providersResponse([provider()]));
    mockListStorePlugins.mockResolvedValue({ items: [] });
    mockListOperatorAgents.mockResolvedValue({ agents: [] });
    mockMcp.mockResolvedValue({});
    mockGetCliBackends.mockResolvedValue({ backends: [], generatedAt: Date.now() });
  });

  async function renderEmbeddingsCard(): Promise<string> {
    render(await DashboardPage());
    const title = screen.getByText('health.embeddings.title');
    const card = title.closest('li');
    if (!card) throw new Error('embeddings health card not found');
    return card.textContent ?? '';
  }

  it('reads OK and names the model when the capability is published', async () => {
    mockGetEmbeddingStatus.mockResolvedValue({
      capabilityPublished: true,
      activeProviderId: '@omadia/embeddings',
      activeModel: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
      installedProviderIds: ['@omadia/embeddings'],
    });
    const text = await renderEmbeddingsCard();
    expect(text).toContain('health.ok');
    expect(text).toContain('health.embeddings.active:{"model":"ollama:nomic-embed-text"}');
    expect(screen.getByTestId('onboarding').dataset['embeddingsOff']).toBe('false');
  });

  it('reads WARN and says so when no embedding provider is published (the round-4 default install)', async () => {
    mockGetEmbeddingStatus.mockResolvedValue({
      capabilityPublished: false,
      activeProviderId: null,
      activeModel: null,
      installedProviderIds: [],
    });
    const text = await renderEmbeddingsCard();
    expect(text).toContain('health.warn');
    expect(text).toContain('health.embeddings.none');
    expect(screen.getByTestId('onboarding').dataset['embeddingsOff']).toBe('true');
  });

  it('does not claim "off" when the status route is unreachable', async () => {
    mockGetEmbeddingStatus.mockRejectedValue(new Error('boom'));
    const text = await renderEmbeddingsCard();
    expect(text).toContain('health.embeddings.unknown');
    expect(screen.getByTestId('onboarding').dataset['embeddingsOff']).toBe('false');
  });
});
