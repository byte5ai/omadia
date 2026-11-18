import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type { AgentTeamsTargetsDto } from '../../../../_lib/agents';
import { TeamsTargetPicker } from '../_components/TeamsTargetPicker';

/**
 * #2043 rollout (D8): a tenant with 725 chats. While the server is still
 * enumerating, each half says so and points to the id field; a list the
 * server cut short says how many there are.
 */
function renderPicker(targets: AgentTeamsTargetsDto): void {
  renderWithIntl(
    <TeamsTargetPicker targets={targets} loading={false} disabled={false} value="" onSelect={() => undefined} />,
  );
}

const base = { ok: true, agent: 'mara', provisioner_installed: true } as const;

describe('TeamsTargetPicker in a large tenant', () => {
  it('shows a still-loading note per half instead of nothing', () => {
    renderPicker({
      ...base,
      teams: { available: true, items: [{ id: 't1', displayName: 'Acme Team' }] },
      chats: { available: false, reason: 'loading' },
    });
    expect(screen.getByText('Pick a team from the list')).toBeTruthy();
    expect(screen.getByText(/The chat list is still being loaded from Microsoft/)).toBeTruthy();
  });

  it('says so when the server sent only part of the list', () => {
    renderPicker({
      ...base,
      teams: { available: false, reason: 'loading' },
      chats: {
        available: true,
        items: [{ id: '19:a@thread.v2', topic: 'Lunch', chatType: 'group' }],
        total: 2500,
        truncated: true,
      },
    });
    expect(screen.getByText(/The team list is still being loaded from Microsoft/)).toBeTruthy();
    expect(screen.getByText(/Showing 1 of 2500\./)).toBeTruthy();
  });

  it('connector 0.9.1: says the list is incomplete at its source, and what the filter can match', () => {
    renderPicker({
      ...base,
      teams: { available: true, items: [{ id: 't1', displayName: 'Acme Team' }] },
      chats: {
        available: true,
        items: [
          { id: '19:a@thread.v2', topic: 'Lunch', chatType: 'group' },
          { id: '19:b@thread.v2', topic: null, chatType: 'group', memberNames: ['Anna', 'Bert'] },
        ],
        total: 2,
        truncated: true,
        sourceTruncated: true,
        withoutMemberNames: 3,
        memberSearch: 'untitled_only',
      },
    });
    expect(screen.getByText(/Microsoft returned only part of this list \(2 entries\), so it is incomplete/)).toBeTruthy();
    expect(screen.queryByText(/Showing 2 of 2\./)).toBeNull();
    expect(screen.getByText(/Members are only searchable for chats without a name/)).toBeTruthy();
    expect(screen.getByText(/3 chats without a name have no member names/)).toBeTruthy();
  });

  it('connector 0.9.0 (no marks): none of the new notes appear', () => {
    renderPicker({
      ...base,
      teams: { available: true, items: [{ id: 't1', displayName: 'Acme Team' }] },
      chats: {
        available: true,
        items: [{ id: '19:a@thread.v2', topic: 'Lunch', chatType: 'group', memberNames: ['Anna'] }],
        memberSearch: 'all',
      },
    });
    expect(screen.queryByText(/incomplete/)).toBeNull();
    expect(screen.queryByText(/Members are only searchable/)).toBeNull();
    expect(screen.queryByText(/no member names/)).toBeNull();
  });
});
