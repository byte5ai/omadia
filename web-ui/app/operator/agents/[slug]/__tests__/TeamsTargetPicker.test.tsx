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

/** The list is a combobox popup now: it exists once the field has focus. */
async function openTeams(): Promise<HTMLElement> {
  const field = screen.getByRole('combobox', { name: /Team/i });
  await userEvent.click(field);
  return field;
}

async function openChats(): Promise<HTMLElement> {
  const field = screen.getByRole('combobox', { name: /Chat/i });
  await userEvent.click(field);
  return field;
}

describe('TeamsTargetPicker — offering a choice', () => {
  it('lists teams and chats with their names', async () => {
    render(dto());

    await openTeams();
    expect(screen.getByRole('option', { name: 'Acme Team' })).toBeInTheDocument();

    await openChats();
    expect(screen.getByRole('option', { name: /Support/ })).toBeInTheDocument();
  });

  it('hands the picked id up verbatim', async () => {
    const { onSelect } = render(dto());

    await openTeams();
    await userEvent.click(screen.getByRole('option', { name: 'Acme Team' }));

    // Verbatim matters: the id goes into the same field the operator could
    // have typed into, and the live classification decides what it is. A
    // picker that reshaped it would become a second, disagreeing classifier.
    expect(onSelect).toHaveBeenCalledWith(TEAM.id);
  });

  it('shows no selection for an id that was typed rather than picked', async () => {
    render(dto(), vi.fn(), { value: 'something-hand-typed' });

    // Never pin the first option: the control must not claim a choice the
    // operator did not make.
    const field = await openTeams();
    expect((field as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('option', { name: 'Acme Team' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('labels a nameless chat by its members rather than dropping it', async () => {
    render(
      dto({
        chats: {
          available: true,
          items: [{ ...CHAT, topic: null, memberNames: ['Ada', 'Grace'] }],
        },
      }),
    );

    await openChats();
    expect(screen.getByRole('option', { name: /Ada, Grace/ })).toBeInTheDocument();
  });
});

/**
 * SEARCH. Thirty teams in one tenant is an alphabetical wall, and a chat with
 * no topic is a `19:…` stem — the part an operator cannot read is exactly the
 * part they have to scroll past. What is pinned here is WHAT the query is
 * allowed to match (the things a human sees, plus the id) and that a miss is
 * an answer rather than an empty list.
 */
describe('TeamsTargetPicker — finding one among many', () => {
  const MANY = Array.from({ length: 30 }, (_, i) => ({
    id: `2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f${String(i).padStart(2, '0')}`,
    displayName: `Team ${String(i).padStart(2, '0')}`,
  }));

  it('narrows a long list to what was typed', async () => {
    render(dto({ teams: { available: true, items: MANY } }));

    const field = await openTeams();
    expect(screen.getAllByRole('option')).toHaveLength(30);

    await userEvent.type(field, 'Team 17');
    const remaining = screen.getAllByRole('option');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveTextContent('Team 17');
  });

  it('finds a chat by a member name the row does not show', async () => {
    // The topic wins the label, so "Grace" is nowhere on screen — and is
    // still how somebody looks for that chat.
    render(
      dto({
        chats: {
          available: true,
          items: [{ ...CHAT, topic: 'Support', memberNames: ['Ada', 'Grace'] }],
        },
      }),
    );

    const field = await openChats();
    await userEvent.type(field, 'grace');

    expect(screen.getByRole('option', { name: /Support/ })).toBeInTheDocument();
  });

  it('matches a pasted id, so it does not look unknown', async () => {
    render(dto());

    const field = await openTeams();
    await userEvent.type(field, TEAM.id);

    expect(screen.getByRole('option', { name: 'Acme Team' })).toBeInTheDocument();
  });

  it('answers a miss with a sentence instead of an empty list', async () => {
    render(dto());

    const field = await openTeams();
    await userEvent.type(field, 'zzzz');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // "Nothing matched" and "this tenant has no teams" are different
    // statements and must not share a rendering.
    expect(await screen.findByRole('status')).toHaveTextContent(/zzzz/);
  });

  it('is operable from the keyboard alone', async () => {
    const { onSelect } = render(dto({ teams: { available: true, items: MANY } }));

    const field = screen.getByRole('combobox', { name: /Team/i });
    await userEvent.click(field);
    await userEvent.type(field, 'Team 03');
    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(onSelect).toHaveBeenCalledWith(MANY[3]?.id);
  });

  it('closes on Escape, then clears the query on a second Escape', async () => {
    render(dto());

    const field = await openTeams();
    await userEvent.type(field, 'Acme');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect((field as HTMLInputElement).value).toBe('Acme');

    await userEvent.keyboard('{Escape}');
    expect((field as HTMLInputElement).value).toBe('');
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

    await openTeams();
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
