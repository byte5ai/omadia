import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import type { AgentDirectoryEntry, AvailableAgents } from '../../_lib/availableAgents';
import { AgentPicker } from '../AgentPicker';

/**
 * #2057 / spec 2042 §5.3, §5.9 — the picker is always shown, by name and
 * avatar, and with one agent it still shows that agent by name.
 */

const { mockDirectory } = vi.hoisted(() => ({ mockDirectory: vi.fn() }));

vi.mock('../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_lib/agents')>()),
  getAgentDirectory: mockDirectory,
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }): React.ReactElement => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function agent(over: Partial<AgentDirectoryEntry> & { slug: string }): AgentDirectoryEntry {
  return {
    name: over.slug,
    avatarUrl: null,
    shortDescription: null,
    archetype: 'standard',
    reach: null,
    isDefault: false,
    ...over,
  };
}

const MIRA = agent({ slug: 'mira-sales', name: 'Mira', isDefault: true });
const TOM = agent({
  slug: 'tom-hr',
  name: 'Tom',
  avatarUrl: '/bot-api/v1/operator/agents/tom-hr/identity/avatar?v=abc',
});

function list(agents: AgentDirectoryEntry[]): AvailableAgents {
  return { agents, defaultSlug: agents.find((a) => a.isDefault)?.slug ?? null };
}

beforeEach(() => {
  mockDirectory.mockReset();
});

describe('<AgentPicker />', () => {
  it('shows a single agent by name, read-only', async () => {
    const onSelect = vi.fn();
    renderWithIntl(<AgentPicker availableAgents={list([MIRA])} onSelect={onSelect} />);

    expect(screen.getByText('Mira')).toBeInTheDocument();
    expect(screen.queryByText('mira-sales')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('mira-sales'));
  });

  it('binds the only agent even when it is not the default', async () => {
    const onSelect = vi.fn();
    renderWithIntl(
      <AgentPicker availableAgents={list([agent({ slug: 'tom-hr', name: 'Tom' })])} onSelect={onSelect} />,
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('tom-hr'));
  });

  it('offers a choice by name with the default pre-selected, and keeps the choice visible', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderWithIntl(
      <AgentPicker availableAgents={list([MIRA, TOM])} onSelect={onSelect} />,
    );

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('mira-sales'));
    await user.click(screen.getByRole('button', { name: /Mira/ }));
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('option', { name: /Mira/ })).toHaveTextContent('(default)');
    expect(screen.getByRole('option', { name: /Tom/ })).toBeInTheDocument();
    expect(screen.queryByText('tom-hr')).toBeNull();

    await user.click(screen.getByRole('option', { name: /Tom/ }));
    expect(onSelect).toHaveBeenLastCalledWith('tom-hr');
    expect(screen.queryByRole('listbox')).toBeNull();

    rerender(<AgentPicker availableAgents={list([MIRA, TOM])} onSelect={onSelect} selectedSlug="tom-hr" />);
    expect(screen.getByRole('button', { name: /Tom/ })).toBeInTheDocument();
  });

  it('shows the pinned agent read-only after the first turn, by name', () => {
    renderWithIntl(
      <AgentPicker availableAgents={list([MIRA, TOM])} onSelect={vi.fn()} pinnedSlug="tom-hr" />,
    );
    expect(screen.getByText('Tom')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('falls back to the slug for a pinned agent that is no longer listed', () => {
    renderWithIntl(
      <AgentPicker availableAgents={list([MIRA])} onSelect={vi.fn()} pinnedSlug="gone-agent" />,
    );
    expect(screen.getByText('gone-agent')).toBeInTheDocument();
  });

  it('shows initials when the agent has no avatar', () => {
    renderWithIntl(<AgentPicker availableAgents={list([MIRA])} onSelect={vi.fn()} />);
    expect(screen.getByText('M')).toBeInTheDocument();
  });

  it('renders the avatar image when the agent has one', () => {
    const { container } = renderWithIntl(
      <AgentPicker availableAgents={list([TOM])} onSelect={vi.fn()} />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(TOM.avatarUrl);
  });

  it('points an operator at the agent page when no agent exists', () => {
    renderWithIntl(<AgentPicker availableAgents={list([])} onSelect={vi.fn()} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/operator/agents');
  });

  it('loads the enabled agents when none are passed in, with name and display name', async () => {
    mockDirectory.mockResolvedValue({
      channel: 'web',
      agents: [
        {
          slug: 'mira-sales',
          display_name: 'Mira',
          short_description: null,
          avatar_url: null,
          archetype: 'standard',
        },
      ],
      default_agent: { slug: 'mira-sales' },
    });
    renderWithIntl(<AgentPicker onSelect={vi.fn()} />);
    expect(await screen.findByText('Mira')).toBeInTheDocument();
  });

  it('shows the catalog text for the server notice code when there is no default agent and none is selected', async () => {
    mockDirectory.mockResolvedValue({
      channel: 'web',
      agents: [
        { slug: 'a', display_name: 'Anna', short_description: null, avatar_url: null, archetype: 'standard' },
        { slug: 'b', display_name: 'Ben', short_description: null, avatar_url: null, archetype: 'standard' },
      ],
      default_agent: { slug: null, notice: 'no_agent' },
    });
    renderWithIntl(<AgentPicker onSelect={vi.fn()} />);
    expect(await screen.findByText(/No agent is set up for you here/)).toBeInTheDocument();
  });

  it('says so when the list cannot be loaded', async () => {
    mockDirectory.mockRejectedValue(new Error('boom'));
    renderWithIntl(<AgentPicker onSelect={vi.fn()} />);
    expect(await screen.findByText('agent list unavailable')).toBeInTheDocument();
  });
});
