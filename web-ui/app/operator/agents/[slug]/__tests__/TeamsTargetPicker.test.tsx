import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type { AgentTeamsTargetsDto } from '../../../../_lib/agents';
import { TeamsTargetPicker } from '../_components/TeamsTargetPicker';

/**
 * Picking a target instead of typing one — and, more importantly, what the
 * picker does when it CANNOT offer a list.
 *
 * The behaviours worth pinning are the honesty ones:
 *
 *  - a list that could not be produced renders a SENTENCE, never an empty
 *    dropdown: an empty `<select>` is a claim about the tenant, and using it
 *    for "I could not look" sends the operator hunting for teams that are
 *    right there;
 *  - the two halves degrade independently — a chat scope nobody consented to
 *    must not be able to hide the team list, which is the half that works
 *    everywhere;
 *  - a picked id is handed up VERBATIM, so the live classification below the
 *    picker stays the single verdict on what the target is.
 */

const TEAM = { id: '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c', displayName: 'Acme Team' };
const CHAT = {
  id: '19:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6@thread.v2',
  topic: 'Support',
  chatType: 'group' as const,
};

function dto(overrides: Partial<AgentTeamsTargetsDto> = {}): AgentTeamsTargetsDto {
  return {
    ok: true,
    agent: 'sales-bot',
    provisioner_installed: true,
    teams: { available: true, items: [TEAM] },
    chats: { available: true, items: [CHAT] },
    ...overrides,
  };
}

function render(
  targets: AgentTeamsTargetsDto | null,
  onSelect = vi.fn(),
  extra: { loading?: boolean; disabled?: boolean; value?: string } = {},
): { onSelect: ReturnType<typeof vi.fn> } {
  renderWithIntl(
    <TeamsTargetPicker
      targets={targets}
      loading={extra.loading ?? false}
      disabled={extra.disabled ?? false}
      value={extra.value ?? ''}
      onSelect={onSelect}
    />,
  );
  return { onSelect };
}

describe('TeamsTargetPicker — offering a choice', () => {
  it('lists teams and chats with their names', () => {
    render(dto());

    expect(screen.getByRole('option', { name: 'Acme Team' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Support/ })).toBeInTheDocument();
  });

  it('hands the picked id up verbatim', async () => {
    const { onSelect } = render(dto());

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /Team/i }),
      TEAM.id,
    );

    // Verbatim matters: the id goes into the same field the operator could
    // have typed into, and the live classification decides what it is. A
    // picker that reshaped it would become a second, disagreeing classifier.
    expect(onSelect).toHaveBeenCalledWith(TEAM.id);
  });

  it('shows no selection for an id that was typed rather than picked', () => {
    render(dto(), vi.fn(), { value: 'something-hand-typed' });

    // Never pin the first option: the select must not claim a choice the
    // operator did not make.
    const select = screen.getByRole('combobox', { name: /Team/i });
    expect((select as HTMLSelectElement).value).toBe('');
  });

  it('labels a nameless chat by its members rather than dropping it', () => {
    render(
      dto({
        chats: {
          available: true,
          items: [{ ...CHAT, topic: null, memberNames: ['Ada', 'Grace'] }],
        },
      }),
    );

    expect(screen.getByRole('option', { name: /Ada, Grace/ })).toBeInTheDocument();
  });
});

describe('TeamsTargetPicker — degrading without lying', () => {
  it('renders a reason, NOT an empty dropdown, when a listing is unavailable', async () => {
    render(
      dto({
        teams: { available: false, reason: 'connector_unsupported' },
        chats: { available: false, reason: 'connector_unsupported' },
      }),
    );

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    // Two notes, each explaining itself — the operator is told to use the
    // field below rather than left in front of a dropdown with nothing in it.
    expect(await screen.findAllByRole('note')).toHaveLength(2);
  });

  it('keeps the team list when only the chat scope is missing', async () => {
    // The connector-0.8.0 case: someone is signed in with a credential that
    // predates `Chat.ReadBasic` and cannot refresh into it.
    render(
      dto({ chats: { available: false, reason: 'scope_missing' } }),
    );

    expect(screen.getByRole('option', { name: 'Acme Team' })).toBeInTheDocument();
    const notes = await screen.findAllByRole('note');
    expect(notes).toHaveLength(1);
    // The sentence has to name the scope, or "sign in again" is
    // indistinguishable from a bug to someone who IS signed in.
    expect(notes[0]).toHaveTextContent(/Chat\.ReadBasic/);
  });

  it('distinguishes an empty tenant from an unavailable listing', () => {
    render(dto({ teams: { available: true, items: [] } }));

    // No dropdown either way — but the copy is a statement about the tenant,
    // and it must not be the same string as "we could not look".
    expect(screen.queryByRole('combobox', { name: /Team/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('renders nothing at all when there is no directory', () => {
    const { container } = { container: document.body };
    render(null);

    // Silent by design: the text field below is fully functional, and a
    // component announcing its own absence would be noise on every screen
    // whose connector predates the feature.
    expect(container.querySelector('select')).toBeNull();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('says it is loading rather than showing an empty list', () => {
    render(null, vi.fn(), { loading: true });

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText(/lade|load/i)).toBeInTheDocument();
  });

  it('disables the selects while an install is in flight', () => {
    render(dto(), vi.fn(), { disabled: true });

    for (const select of screen.getAllByRole('combobox')) {
      expect(select).toBeDisabled();
    }
  });
});
