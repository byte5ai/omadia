import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AgentReachDto } from '../../../_lib/agents';
import { renderWithIntl } from '../../../_lib/test-utils';
import { AgentReachPanel } from '../AgentReach';

/** #2320 / #2319 — the reach lists the agent's granted credentials and hosts. */

const base: AgentReachDto = { systems: [], connected_systems: 2, covers_every_system: false, broad: false };

describe('<AgentReachPanel /> credential hosts', () => {
  it('lists each granted credential with its host, personal without one', () => {
    renderWithIntl(
      <AgentReachPanel
        reach={{
          ...base,
          credential_hosts: [
            { credential_id: 'c1', name: 'org-notion', kind: 'service', host: 'api.notion.com' },
            { credential_id: 'c2', name: 'alice-github', kind: 'personal', host: null },
          ],
        }}
      />,
    );
    const block = screen.getByTestId('agent-reach-credentials');
    expect(block).toHaveTextContent('org-notion');
    expect(block).toHaveTextContent('api.notion.com');
    expect(block).toHaveTextContent('personal, no fixed host');
  });

  it('shows no credential block without grants or on an older middleware', () => {
    const { rerender } = renderWithIntl(<AgentReachPanel reach={{ ...base, credential_hosts: [] }} />);
    expect(screen.queryByTestId('agent-reach-credentials')).toBeNull();
    rerender(<AgentReachPanel reach={base} />);
    expect(screen.queryByTestId('agent-reach-credentials')).toBeNull();
  });
});
