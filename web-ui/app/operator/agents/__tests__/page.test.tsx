import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';

/**
 * The orchestrator page on a fresh install.
 *
 * Without LLM access the middleware publishes no `orchestratorRegistry@1`, and
 * both routes this page reads answer the structured 503
 * `multi_orchestrator_unavailable`. The dashboard links here, and the page
 * used to print `GET /v1/operator/agents failed: 503` twice. The expected
 * first-start state now renders a setup state with the cause's copy; any
 * other failure must still surface as an error, with its detail.
 */

const { mockListAgents, mockListChannels, mockRedirect } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  mockListChannels: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('../../../../messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace: namespace as never }),
  };
});

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('../../../_lib/agents', () => ({ listOperatorAgents: mockListAgents }));
vi.mock('../../../_lib/channels', () => ({ listOperatorChannels: mockListChannels }));
vi.mock('../../../_lib/authRedirect', () => ({ redirectIfUnauthorized: mockRedirect }));
vi.mock('../_components/AgentsDashboard', () => ({
  AgentsDashboard: () => <div data-testid="agents-dashboard" />,
}));
vi.mock('../../channels/_components/ChannelsDashboard', () => ({
  ChannelsDashboard: () => <div data-testid="channels-dashboard" />,
}));

const { default: OperatorAgentsPage } = await import('../page');

function unavailable(path: string, cause?: string): ApiError {
  const body = { error: 'multi_orchestrator_unavailable', message: 'not published', cause };
  return new ApiError(503, `GET ${path} failed: 503`, JSON.stringify(body));
}

async function renderPage(): Promise<void> {
  renderWithIntl(await OperatorAgentsPage());
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('<OperatorAgentsPage /> first start', () => {
  it('explains the missing LLM access instead of printing two 503s', async () => {
    mockListAgents.mockRejectedValue(unavailable('/v1/operator/agents', 'no_llm_access'));
    mockListChannels.mockRejectedValue(unavailable('/v1/operator/channels'));
    await renderPage();

    const state = screen.getByTestId('orchestrator-setup-state');
    expect(state).toHaveAttribute('data-cause', 'no_llm_access');
    expect(screen.getByText('No orchestrator is running yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open LLM access' })).toHaveAttribute(
      'href',
      '/admin/providers',
    );
    expect(screen.getByTestId('channels-await-setup')).toHaveTextContent(
      'Channel routing becomes available once an orchestrator is running.',
    );
    expect(screen.queryByText(/failed: 503/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('follows the cause: an access without assignment leads to the assignment', async () => {
    mockListAgents.mockRejectedValue(unavailable('/v1/operator/agents', 'no_assignment'));
    mockListChannels.mockRejectedValue(unavailable('/v1/operator/channels'));
    await renderPage();

    expect(screen.getByTestId('orchestrator-setup-state')).toHaveAttribute(
      'data-cause',
      'no_assignment',
    );
    expect(screen.getByText('Orchestrator not assigned yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open assignment' })).toBeInTheDocument();
  });
});

describe('<OperatorAgentsPage /> real failures stay errors', () => {
  it.each([
    ['a 500 from the route', new ApiError(500, 'GET /v1/operator/agents failed: 500', '{}')],
    ['a 503 without the marker', new ApiError(503, 'GET /v1/operator/agents failed: 503', '')],
    ['a transport error', new TypeError('fetch failed')],
  ])('shows %s as an error, with its detail', async (_label, error) => {
    mockListAgents.mockRejectedValue(error);
    mockListChannels.mockRejectedValue(unavailable('/v1/operator/channels'));
    await renderPage();

    expect(screen.queryByTestId('orchestrator-setup-state')).toBeNull();
    // The channels 503 alone does not claim a first start either.
    expect(screen.queryByTestId('channels-await-setup')).toBeNull();
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('Failed to load orchestrators');
    expect(alerts[0]).toHaveTextContent(error.message);
    expect(alerts[1]).toHaveTextContent('Failed to load channels');
  });

  it('keeps a channels failure visible while the orchestrators load', async () => {
    mockListAgents.mockResolvedValue({ agents: [] });
    mockListChannels.mockRejectedValue(unavailable('/v1/operator/channels'));
    await renderPage();

    expect(screen.getByTestId('agents-dashboard')).toBeInTheDocument();
    expect(screen.queryByTestId('channels-await-setup')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load channels');
  });

  it('keeps a channels outage visible beside the setup state', async () => {
    mockListAgents.mockRejectedValue(unavailable('/v1/operator/agents', 'no_llm_access'));
    mockListChannels.mockRejectedValue(new TypeError('fetch failed'));
    await renderPage();

    expect(screen.getByTestId('orchestrator-setup-state')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('fetch failed');
  });

  it('hands both rejections to the session redirect first', async () => {
    const agentsError = new ApiError(401, 'GET /v1/operator/agents failed: 401', '');
    const channelsError = new ApiError(401, 'GET /v1/operator/channels failed: 401', '');
    mockListAgents.mockRejectedValue(agentsError);
    mockListChannels.mockRejectedValue(channelsError);
    await renderPage();

    expect(mockRedirect).toHaveBeenCalledWith(agentsError);
    expect(mockRedirect).toHaveBeenCalledWith(channelsError);
  });
});
