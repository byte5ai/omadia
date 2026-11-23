import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import type { AgentDirectoryEntry, AvailableAgents } from '../../../_lib/availableAgents';
import { AgentDirectory } from '../AgentDirectory';

/** #2057 — the agent directory shows what the list reports and nothing else. */

/** The sentence the middleware seeds for the default agent on first boot. */
const FALLBACK_AGENT_SEED_DESCRIPTION =
  'Auto-seeded on first boot. Receives unbound channel traffic until the operator configures explicit bindings.';

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

function list(agents: AgentDirectoryEntry[]): AvailableAgents {
  return { agents, defaultSlug: null };
}

describe('<AgentDirectory />', () => {
  it('shows name, short description, archetype and reach of an agent', () => {
    renderWithIntl(
      <AgentDirectory
        availableAgents={list([
          agent({
            slug: 'mira-sales',
            name: 'Mira',
            shortDescription: 'Prepares offers',
            reach: ['Odoo', 'Confluence'],
            isDefault: true,
          }),
        ])}
      />,
    );
    const card = within(screen.getByTestId('agent-card-mira-sales'));
    expect(card.getByRole('heading', { name: 'Mira' })).toBeInTheDocument();
    expect(card.getByText('Prepares offers')).toBeInTheDocument();
    expect(card.getByText('Standard agent')).toBeInTheDocument();
    expect(card.getByText('default')).toBeInTheDocument();
    expect(card.getByText(/Odoo, Confluence/)).toBeInTheDocument();
  });

  it('leaves out description and reach the list does not report', () => {
    renderWithIntl(<AgentDirectory availableAgents={list([agent({ slug: 'tom-hr', name: 'Tom' })])} />);
    const card = screen.getByTestId('agent-card-tom-hr');
    expect(within(card).queryByText(/Reach/)).toBeNull();
    expect(card.querySelector('p')).toBeNull();
  });

  it('names the archetype: built-in, facilitator, a plugin label, or the raw id', () => {
    renderWithIntl(
      <AgentDirectory
        archetypeLabels={{ coach: 'Coach' }}
        availableAgents={list([
          agent({ slug: 'a', name: 'A', archetype: 'facilitator' }),
          agent({ slug: 'b', name: 'B', archetype: 'coach' }),
          agent({ slug: 'c', name: 'C', archetype: 'unknown-kind' }),
        ])}
      />,
    );
    expect(screen.getByText('Facilitator')).toBeInTheDocument();
    expect(screen.getByText('Coach')).toBeInTheDocument();
    expect(screen.getByText('unknown-kind')).toBeInTheDocument();
  });

  it('replaces the boot-seeded English description with the catalogue sentence', () => {
    renderWithIntl(
      <AgentDirectory
        availableAgents={list([
          agent({ slug: 'fallback', name: 'Fallback', shortDescription: FALLBACK_AGENT_SEED_DESCRIPTION }),
        ])}
      />,
    );
    expect(screen.queryByText(FALLBACK_AGENT_SEED_DESCRIPTION)).toBeNull();
    expect(screen.getByText('Answers when nobody addressed a specific agent.')).toBeInTheDocument();
  });

  it('says so when no agent is available', () => {
    renderWithIntl(<AgentDirectory availableAgents={list([])} />);
    expect(screen.getByText('No agents are available to you in this channel.')).toBeInTheDocument();
  });

  it('renders German texts under the German locale', () => {
    renderWithIntl(<AgentDirectory availableAgents={list([agent({ slug: 'x', name: 'X' })])} />, {
      locale: 'de',
    });
    expect(screen.getByText('Standard-Agent')).toBeInTheDocument();
  });
});
