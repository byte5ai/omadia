import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { ArchetypeInstallConfirm } from '../ArchetypeInstallConfirm';

/**
 * #2088 — before an archetype plugin is installed the operator sees what the
 * archetype adds, what its agents never get and what such an agent needs:
 * the lists the middleware will enforce, in sentences.
 */
const ARCHETYPE = {
  id: 'facilitator',
  label: { en: 'Facilitator', de: 'Facilitator' },
  description: { en: 'An impartial moderator of group processes.' },
  omits: ['memory', 'plugin_grant', 'default_agent'],
  adds: ['conversation_messages', 'agent_turn'],
  requires: ['own_channel_identity'],
};

describe('<ArchetypeInstallConfirm />', () => {
  it('says what is added, what is never given and what is needed, and asks', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderWithIntl(
      <ArchetypeInstallConfirm
        pluginName="Archetype Facilitator"
        archetype={ARCHETYPE}
        busy={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Add the archetype “Facilitator”?' })).toBeTruthy();
    expect(screen.getByText(/“Archetype Facilitator” is an archetype plugin/)).toBeTruthy();
    expect(screen.getByText('An impartial moderator of group processes.')).toBeTruthy();

    const adds = screen.getByTestId('archetype-adds').textContent ?? '';
    expect(adds).toContain('receives every message people write in a conversation such an agent moderates');
    expect(adds).toContain('every answer runs through omadia');
    const omits = screen.getByTestId('archetype-omits').textContent ?? '';
    expect(omits).toContain('General memory across conversations.');
    expect(omits).toContain('Capability plugins');
    expect(omits).toContain('The role of default agent.');
    expect(screen.getByTestId('archetype-requires').textContent).toContain('Its own identity in the channel it works in');

    await userEvent.click(screen.getByRole('button', { name: 'Add “Facilitator” and install' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a code this version has no sentence for as its code, never as nothing', () => {
    renderWithIntl(
      <ArchetypeInstallConfirm
        pluginName="Coach"
        archetype={{ id: 'coach', omits: ['web_access'], adds: [], requires: [] }}
        busy
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    // No label: the id stands in.
    expect(screen.getByRole('heading', { name: 'Add the archetype “coach”?' })).toBeTruthy();
    expect(screen.getByTestId('archetype-omits').textContent).toContain('web_access (no description in this version)');
    expect(screen.getByTestId('archetype-adds').textContent).toContain('Nothing beyond what every agent has.');
    expect(screen.queryByTestId('archetype-requires')).toBeNull();
    // Busy: neither button can be pressed twice.
    expect((screen.getByRole('button', { name: 'Starting the install …' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
