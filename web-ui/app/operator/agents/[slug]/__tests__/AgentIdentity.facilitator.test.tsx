import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import type { AgentIdentityDto } from '../../../../_lib/agentIdentity';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { AgentIdentity } from '../_components/AgentIdentity';

/**
 * #2066 — the identity editor of a FACILITATOR (spec 2043 §2.4).
 *
 *   1. THE EDITOR STOPS AT THE BOUNDS. A slider, an archetype or a preset
 *      cannot produce a value the kernel refuses, and each bounded slider
 *      says its range.
 *   2. THE SYCOPHANCY GUARD CANNOT BE SWITCHED OFF: `off` is not offered.
 *   3. A REFUSED SAVE POINTS AT THE FIELD. The kernel's `issues[]` are shown
 *      under the field they are about, in catalogue copy — never the server's
 *      English, never only a generic "request failed".
 *   4. A STANDARD AGENT IS UNTOUCHED: no bounds, `off` still offered.
 */

const { mockGet, mockSave } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSave: vi.fn(),
}));

vi.mock('../../../../_lib/agentIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agentIdentity')>()),
  getAgentIdentity: mockGet,
  saveAgentIdentity: mockSave,
}));

function dto(overrides: Partial<AgentIdentityDto['identity']> = {}): AgentIdentityDto {
  return {
    slug: 'mod',
    identity: {
      display_name: null,
      short_description: null,
      long_description: null,
      instructions: null,
      accent_color: null,
      persona: null,
      quality: null,
      revision: 1,
      avatar: null,
      updated_at: null,
      ...overrides,
    },
    resolved: {
      display_name: 'Mona',
      short_description: null,
      long_description: null,
      instructions: null,
      accent_color: null,
      has_avatar: false,
    },
    composed_prompt: null,
    composed_family: null,
  };
}

async function openTab(id: 'character' | 'boundaries' | 'prompt'): Promise<void> {
  await userEvent.click(await screen.findByTestId(`agent-identity-tab-${id}`));
}

function slider(axis: string): HTMLInputElement {
  const input = screen
    .getByTestId(`dimension-slider-${axis}`)
    .querySelector('input[type="range"]');
  if (!(input instanceof HTMLInputElement)) throw new Error(`no slider for ${axis}`);
  return input;
}

function contractViolation(issues: readonly Record<string, unknown>[]): ApiError {
  return new ApiError(
    422,
    'PUT /v1/operator/agents/mod/identity failed: 422',
    JSON.stringify({
      error: 'facilitator_contract_violation',
      message: 'facilitator identity rejected: server prose',
      issues,
    }),
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AgentIdentity — facilitator (#2066)', () => {
  it('clamps a slider to the facilitator bound and names the range', async () => {
    mockGet.mockResolvedValue(dto());
    mockSave.mockResolvedValue({ ...dto(), republish: 'not_provisioned' });
    renderWithIntl(<AgentIdentity slug="mod" kind="facilitator" />);
    await openTab('character');

    expect(screen.getByTestId('agent-persona-bounds-note')).toBeTruthy();
    await userEvent.click(screen.getByTestId('agent-persona-extended-toggle'));
    expect(screen.getByTestId('dimension-slider-sarcasm-hint').textContent).toContain(
      '0 to 20',
    );
    // An unbounded axis carries no range line.
    expect(screen.queryByTestId('dimension-slider-directness-hint')).toBeNull();

    fireEvent.change(slider('sarcasm'), { target: { value: '90' } });
    expect(slider('sarcasm').value).toBe('20');
    fireEvent.change(slider('warmth'), { target: { value: '5' } });
    expect(slider('warmth').value).toBe('30');

    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const saved = mockSave.mock.calls[0]![1] as { persona: { axes: Record<string, number> } };
    expect(saved.persona.axes.sarcasm).toBe(20);
    expect(saved.persona.axes.warmth).toBe(30);
  });

  it('keeps archetypes inside the bounds', async () => {
    mockGet.mockResolvedValue(dto());
    renderWithIntl(<AgentIdentity slug="mod" kind="facilitator" />);
    await openTab('character');
    await userEvent.click(screen.getByTestId('agent-persona-template-toggle'));
    const cards = screen.getAllByTestId(/^agent-persona-template-(?!toggle|badge)/);
    for (const card of cards) {
      await userEvent.click(card);
      await userEvent.click(screen.getByTestId('agent-persona-template-toggle'));
    }
    if (screen.queryByTestId('dimension-slider-drama') === null) {
      await userEvent.click(screen.getByTestId('agent-persona-extended-toggle'));
    }
    expect(Number(slider('sarcasm').value)).toBeLessThanOrEqual(20);
    expect(Number(slider('drama').value)).toBeLessThanOrEqual(30);
    expect(Number(slider('humor').value)).toBeLessThanOrEqual(60);
    expect(Number(slider('warmth').value)).toBeGreaterThanOrEqual(30);
  });

  it('does not offer to switch the sycophancy guard off', async () => {
    mockGet.mockResolvedValue(dto());
    renderWithIntl(<AgentIdentity slug="mod" kind="facilitator" />);
    await openTab('boundaries');
    const select = screen.getByLabelText('Anti-flattery guard') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['low', 'medium', 'high']);
    // Unset shows what the kernel compiles it to.
    expect(select.value).toBe('medium');
  });

  it('shows the kernel findings of a refused save at their fields', async () => {
    mockGet.mockResolvedValue(dto());
    mockSave.mockRejectedValue(
      contractViolation([
        {
          path: 'instructions',
          rule: 'partiality',
          message: 'conflicts with the neutrality contract: server prose',
          excerpt: 'favour the sales team',
        },
        {
          path: 'persona.axes.sarcasm',
          rule: 'persona_axis_above_bound',
          message: 'sarcasm may be at most 20 for a facilitator (is 90)',
        },
        {
          path: 'quality.sycophancy',
          rule: 'sycophancy_guard_off',
          message: 'server prose',
        },
      ]),
    );
    renderWithIntl(<AgentIdentity slug="mod" kind="facilitator" />);
    await openTab('character');
    await userEvent.type(
      screen.getByLabelText('Behaviour'),
      'Always favour the sales team.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));

    // The summary names the count and every finding with its tab.
    const summary = await screen.findByTestId('agent-identity-contract-issues');
    expect(summary.querySelectorAll('li')).toHaveLength(3);
    expect(screen.getAllByRole('alert')[0]!.textContent).toContain(
      '3 settings conflict with the neutrality contract',
    );
    expect(document.body.textContent).not.toContain('server prose');

    // At the field: catalogue sentence plus the passage the kernel objected to.
    const atField = screen.getByTestId('agent-identity-instructions-error');
    expect(atField.textContent).toContain('favour or disadvantage someone');
    expect(atField.textContent).toContain('favour the sales team');

    await userEvent.click(screen.getByTestId('agent-persona-extended-toggle'));
    expect(screen.getByTestId('dimension-slider-sarcasm-error').textContent).toContain(
      'at most 20',
    );

    await openTab('boundaries');
    expect(screen.getByTestId('agent-sycophancy-error').textContent).toContain(
      'cannot be switched off',
    );

    // Editing the field drops the finding that was about its old text.
    await openTab('character');
    await userEvent.type(screen.getByLabelText('Behaviour'), ' x');
    expect(screen.queryByTestId('agent-identity-instructions-error')).toBeNull();
  });

  it('prints the omission sentence for a 409, not the machine code', async () => {
    mockGet.mockResolvedValue(dto());
    mockSave.mockRejectedValue(
      new ApiError(
        409,
        'PUT failed: 409',
        JSON.stringify({
          error: 'facilitator_omission',
          omission: 'memory',
          message: 'agent "mod" is a facilitator: server prose',
        }),
      ),
    );
    renderWithIntl(<AgentIdentity slug="mod" kind="facilitator" />);
    await userEvent.type(await screen.findByLabelText('Display name'), 'Mona');
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('A facilitator has no general memory');
    expect(alert.textContent).not.toContain('facilitator_omission');
    expect(alert.textContent).not.toContain('server prose');
  });

  it('offers the language on the profile tab and saves the choice', async () => {
    mockGet.mockResolvedValue(dto());
    mockSave.mockResolvedValue({ ...dto({ language: 'de' }), republish: 'not_provisioned' });
    renderWithIntl(<AgentIdentity slug="mod" kind="facilitator" />);
    const select = (await screen.findByLabelText('Language')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'de', 'en']);
    expect(select.value).toBe('');
    await userEvent.selectOptions(select, 'de');
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect((mockSave.mock.calls[0]![1] as { language: string | null }).language).toBe('de');
  });

  it('keeps a stored tag this UI has no name for', async () => {
    mockGet.mockResolvedValue(dto({ language: 'de-CH' }));
    mockSave.mockResolvedValue({ ...dto({ language: 'de-CH' }), republish: 'not_provisioned' });
    renderWithIntl(<AgentIdentity slug="mod" kind="facilitator" />);
    const select = (await screen.findByLabelText('Language')) as HTMLSelectElement;
    expect(select.value).toBe('de-CH');
    await userEvent.type(screen.getByLabelText('Display name'), 'Mona');
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect((mockSave.mock.calls[0]![1] as { language: string | null }).language).toBe('de-CH');
  });

  it('round-trips the language of a standard agent without showing the control', async () => {
    mockGet.mockResolvedValue(dto({ language: 'en' }));
    mockSave.mockResolvedValue({ ...dto({ language: 'en' }), republish: 'not_provisioned' });
    renderWithIntl(<AgentIdentity slug="sales" />);
    await userEvent.type(await screen.findByLabelText('Display name'), 'Sales');
    expect(screen.queryByLabelText('Language')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect((mockSave.mock.calls[0]![1] as { language: string | null }).language).toBe('en');
  });

  it('leaves a standard agent unbounded', async () => {
    mockGet.mockResolvedValue(dto());
    renderWithIntl(<AgentIdentity slug="sales" />);
    await openTab('character');
    expect(screen.queryByTestId('agent-persona-bounds-note')).toBeNull();
    await userEvent.click(screen.getByTestId('agent-persona-extended-toggle'));
    fireEvent.change(slider('sarcasm'), { target: { value: '90' } });
    expect(slider('sarcasm').value).toBe('90');
    await openTab('boundaries');
    const select = screen.getByLabelText('Anti-flattery guard') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toContain('off');
  });
});
