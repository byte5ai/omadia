import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OperatorAgentDto } from '../../../../_lib/agents';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { AgentsDashboard } from '../AgentsDashboard';

/**
 * #1884 — "Drain sessions" ran on click without a question, and neither
 * action said what it did: the dashboard dropped the `affected` count.
 */

const { mockDrain, mockKill, mockRefresh } = vi.hoisted(() => ({
  mockDrain: vi.fn(),
  mockKill: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }): React.ReactElement => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  listAgentPluginCatalog: vi.fn().mockResolvedValue({ items: [] }),
  listDeletedAgents: vi.fn().mockResolvedValue({ retention_days: 30, agents: [] }),
  drainAgentSessions: mockDrain,
  killAgentSessions: mockKill,
}));

vi.mock('../PluginsDnd', () => ({
  PluginsDnd: () => <div data-testid="plugins-dnd" />,
}));

const SALES: OperatorAgentDto = {
  id: 'id-sales',
  slug: 'sales',
  name: 'Sales',
  description: null,
  privacy_profile: 'default',
  status: 'enabled',
  created_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
  active: true,
  memory_scope: [],
  plugins: [],
  bindings: [],
};

afterEach(() => {
  vi.clearAllMocks();
});

async function openCard(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderWithIntl(<AgentsDashboard initial={{ agents: [SALES], default_agent_id: 'id-sales' }} />);
  await user.click(screen.getByRole('button', { name: /Sales/ }));
  return user;
}

describe('AgentsDashboard — drain and kill (#1884)', () => {
  it('asks before draining and reports how many chats were released', async () => {
    mockDrain.mockResolvedValue({ ok: true, affected: 3 });
    const user = await openCard();
    await user.click(screen.getByRole('button', { name: 'Drain sessions' }));
    expect(mockDrain).not.toHaveBeenCalled();
    expect(screen.getByText(/Release all web chats pinned to "sales"/)).toBeTruthy();

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Drain sessions' }));
    await waitFor(() => expect(mockDrain).toHaveBeenCalledWith('sales'));
    expect(await screen.findByText('3 web chats released from "sales".')).toBeTruthy();
  });

  it('says so when no chat was pinned to the agent', async () => {
    mockKill.mockResolvedValue({ ok: true, affected: 0 });
    const user = await openCard();
    await user.click(screen.getByRole('button', { name: 'Kill sessions' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Kill sessions' }));
    await waitFor(() => expect(mockKill).toHaveBeenCalledWith('sales'));
    expect(await screen.findByText('No web chat is pinned to "sales".')).toBeTruthy();
  });
});
