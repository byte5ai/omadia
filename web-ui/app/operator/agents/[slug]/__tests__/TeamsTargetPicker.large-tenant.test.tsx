import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';

const { mockTargets } = vi.hoisted(() => ({ mockTargets: vi.fn() }));
vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getAgentTeamsTargets: mockTargets,
}));

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

  describe('the tenant is not enumerated to open the picker (#2043 D8)', () => {
    const DEFAULT: AgentTeamsTargetsDto = {
      ...base,
      teams: { available: true, items: [{ id: 't1', displayName: 'Acme Team' }] },
      chats: { available: false, reason: 'not_requested' },
      recent: [
        { id: '19:meeting_abc@thread.v2', kind: 'group-chat', label: 'Testbesprechung', knownToThisBot: true },
        { id: '19:9cdb@thread.skype', kind: 'group-chat', label: null, knownToThisBot: false },
      ],
    };

    beforeEach(() => {
      mockTargets.mockReset();
    });

    function renderWithSearch(targets: AgentTeamsTargetsDto, onSelect = vi.fn()): typeof onSelect {
      renderWithIntl(
        <TeamsTargetPicker
          targets={targets}
          loading={false}
          disabled={false}
          value=""
          onSelect={onSelect}
          slug="mona"
        />,
      );
      return onSelect;
    }

    it('offers the chats the bots are already in, a search field, and says what to type', () => {
      renderWithSearch(DEFAULT);
      expect(screen.getByText('Chats your bots are already in')).toBeTruthy();
      expect(screen.getByLabelText('Search all chats of the tenant')).toBeTruthy();
      expect(screen.getByText(/Type at least two characters/)).toBeTruthy();
      expect(mockTargets).not.toHaveBeenCalled();
    });

    it('an instance whose bots are in no chat yet says so', () => {
      renderWithSearch({ ...DEFAULT, recent: [] });
      expect(screen.getByText(/None of this instance’s bots is in a chat yet/)).toBeTruthy();
    });

    it('searches on the server, shows that it is searching, and then the results', async () => {
      mockTargets
        .mockResolvedValueOnce({ ...DEFAULT, chats: { available: false, reason: 'loading' } })
        .mockResolvedValue({
          ...DEFAULT,
          chats: { available: true, items: [{ id: '19:04000@thread.v2', topic: 'Safeword-Runde', chatType: 'group' }] },
        });
      renderWithSearch(DEFAULT);
      const input = screen.getByLabelText('Search all chats of the tenant');
      fireEvent.change(input, { target: { value: 's' } });
      expect(mockTargets).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: 'safe' } });
      await waitFor(() => expect(screen.getByText(/Searching for “safe”/)).toBeTruthy());
      expect(mockTargets).toHaveBeenCalledWith('mona', { q: 'safe' });
      await waitFor(() => expect(screen.getByText('Chats matching “safe”')).toBeTruthy(), { timeout: 6000 });
    }, 10_000);

    it('a search that finds nothing, and one that could not run, are both visible states', async () => {
      mockTargets.mockResolvedValueOnce({ ...DEFAULT, chats: { available: true, items: [] } });
      renderWithSearch(DEFAULT);
      const input = screen.getByLabelText('Search all chats of the tenant');
      fireEvent.change(input, { target: { value: 'zzz' } });
      await waitFor(() => expect(screen.getByText(/No chat is called “zzz”/)).toBeTruthy(), { timeout: 3000 });
      mockTargets.mockRejectedValueOnce(new Error('504'));
      fireEvent.change(input, { target: { value: 'zzzz' } });
      await waitFor(() => expect(screen.getByText(/The chat list could not be loaded just now/)).toBeTruthy(), {
        timeout: 3000,
      });
    }, 10_000);
  });
});
