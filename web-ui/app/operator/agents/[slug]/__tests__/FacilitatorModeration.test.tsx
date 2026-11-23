import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { FacilitatorDefaults } from '../_components/FacilitatorDefaults';
import { FacilitatorWorkingModes } from '../_components/FacilitatorWorkingModes';

/**
 * #2066, #2060 — the moderation tab of a facilitator.
 *
 *   1. DEFAULTS PER FACILITATOR: the fields the archetype plugin declares,
 *      each starting on "Instance setting"; saving sends the set values and
 *      `null` for fields left on the instance setting.
 *   2. WORKING MODES: a moderation mode is attached; a refused one shows the
 *      kernel's findings as sentences.
 */

const { mockGet, mockSave, mockGraph, mockSkills, mockAdd, mockRemove } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSave: vi.fn(),
  mockGraph: vi.fn(),
  mockSkills: vi.fn(),
  mockAdd: vi.fn(),
  mockRemove: vi.fn(),
}));

vi.mock('../../../../_lib/archetypeSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/archetypeSettings')>()),
  getArchetypeSettings: mockGet,
  saveArchetypeSettings: mockSave,
}));

vi.mock('../../../../_lib/agentBuilder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agentBuilder')>()),
  getAgentGraph: mockGraph,
  listSkills: mockSkills,
  addPersonaSkill: mockAdd,
  removePersonaSkill: mockRemove,
}));

const FIELDS = [
  {
    key: 'default_decision_method',
    type: 'enum',
    label: { en: 'Default decision method', de: 'Standard-Entscheidungsmethode' },
    help: null,
    options: [
      { value: 'ranked', label: { en: 'Ranked vote', de: 'Rangwahl' } },
      { value: 'consent', label: { en: 'Consent', de: 'Konsent' } },
    ],
    max_items: null,
  },
  {
    key: 'reminder_offsets_hours',
    type: 'number_list',
    label: { en: 'Reminders before the deadline (hours)', de: 'Erinnerungen vor der Deadline (Stunden)' },
    help: null,
    options: null,
    max_items: 10,
  },
] as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe('FacilitatorDefaults (#2066)', () => {
  it('saves a facilitator default and keeps the other field on the instance setting', async () => {
    mockGet.mockResolvedValue({ archetype: 'facilitator', fields: FIELDS, values: {} });
    mockSave.mockImplementation(async (_slug: string, settings: Record<string, unknown>) => ({
      archetype: 'facilitator',
      fields: FIELDS,
      values: Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== null)),
    }));
    renderWithIntl(<FacilitatorDefaults slug="mona" />);

    const method = (await screen.findByTestId('facilitator-default-default_decision_method')) as HTMLSelectElement;
    expect(method.value).toBe('');
    expect(method.options[0]?.textContent).toBe('Instance setting');
    await userEvent.selectOptions(method, 'consent');
    await userEvent.type(screen.getByTestId('facilitator-default-reminder_offsets_hours'), '48, 4');
    await userEvent.click(screen.getByTestId('facilitator-defaults-save'));

    await waitFor(() =>
      expect(mockSave).toHaveBeenCalledWith('mona', {
        default_decision_method: 'consent',
        reminder_offsets_hours: [48, 4],
      }),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('clears a field back to the instance setting and refuses a bad list locally', async () => {
    mockGet.mockResolvedValue({
      archetype: 'facilitator',
      fields: FIELDS,
      values: { default_decision_method: 'ranked', reminder_offsets_hours: [24] },
    });
    mockSave.mockResolvedValue({ archetype: 'facilitator', fields: FIELDS, values: {} });
    renderWithIntl(<FacilitatorDefaults slug="mona" />);

    const list = (await screen.findByTestId('facilitator-default-reminder_offsets_hours')) as HTMLInputElement;
    expect(list.value).toBe('24');
    await userEvent.clear(list);
    await userEvent.type(list, 'soon');
    await userEvent.click(screen.getByTestId('facilitator-defaults-save'));
    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('positive numbers');

    await userEvent.clear(list);
    await userEvent.selectOptions(screen.getByTestId('facilitator-default-default_decision_method'), '');
    await userEvent.click(screen.getByTestId('facilitator-defaults-save'));
    await waitFor(() =>
      expect(mockSave).toHaveBeenCalledWith('mona', {
        default_decision_method: null,
        reminder_offsets_hours: null,
      }),
    );
  });
});

const RETRO = { id: 'skill-retro', slug: 'retro', name: 'Retrospective', description: 'Start, stop, continue', body: '', source: 'db' };
const MIRA = { id: 'skill-mira', slug: 'mira', name: 'Mira persona', description: null, body: '', source: 'db' };

describe('FacilitatorWorkingModes (#2060)', () => {
  it('attaches a moderation mode', async () => {
    mockGraph.mockResolvedValueOnce({ agent: { personaSkillIds: [] } });
    mockGraph.mockResolvedValue({ agent: { personaSkillIds: ['skill-retro'] } });
    mockSkills.mockResolvedValue({ skills: [RETRO, MIRA] });
    mockAdd.mockResolvedValue({ agentId: 'id-mona', skillId: 'skill-retro', position: 0, risks: [] });
    renderWithIntl(<FacilitatorWorkingModes slug="mona" />);

    await userEvent.selectOptions(await screen.findByTestId('facilitator-working-mode-select'), 'skill-retro');
    await userEvent.click(screen.getByTestId('facilitator-working-mode-add'));

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith('mona', 'skill-retro'));
    expect((await screen.findByTestId('facilitator-working-mode')).textContent).toContain('Retrospective');
  });

  it('shows why a mode that replaces the identity is refused', async () => {
    mockGraph.mockResolvedValue({ agent: { personaSkillIds: [] } });
    mockSkills.mockResolvedValue({ skills: [RETRO, MIRA] });
    mockAdd.mockRejectedValue(
      new ApiError(
        422,
        'POST failed: 422',
        JSON.stringify({
          error: 'facilitator_contract_violation',
          message: 'working mode rejected',
          issues: [
            {
              path: 'working_mode.body',
              rule: 'identity_replacement',
              message: 'gives the agent another name',
              excerpt: 'Your name is Mira',
            },
          ],
        }),
      ),
    );
    renderWithIntl(<FacilitatorWorkingModes slug="mona" />);

    await userEvent.selectOptions(await screen.findByTestId('facilitator-working-mode-select'), 'skill-mira');
    await userEvent.click(screen.getByTestId('facilitator-working-mode-add'));

    const refused = await screen.findByTestId('facilitator-working-mode-refused');
    expect(refused.textContent).toContain('never who speaks');
    expect(refused.textContent).toContain('Your name is Mira');
    expect(screen.queryByTestId('facilitator-working-mode')).toBeNull();
  });
});
