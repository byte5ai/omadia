import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type { AgentIdentityDto } from '../../../../_lib/agentIdentity';
import { getPersonaTemplate } from '../../../../_lib/personaTemplates';
import { AgentIdentity } from '../_components/AgentIdentity';

/**
 * #914 follow-up — the character half of the identity section: the same
 * 12-axis persona model, archetypes, culture presets and boundary library the
 * Agent Builder edits, attached to a DEPLOYED agent.
 *
 * What is pinned here is what makes it usable rather than decorative:
 *
 *   1. FOUR TABS, ONE DOCUMENT. An edit made on one tab survives a switch to
 *      another and is still in the single save — the failure this design
 *      exists to prevent is an operator losing half a character.
 *   2. ARCHETYPES AND PRESETS ACTUALLY MOVE THE AXES, client-side, so the
 *      operator sees the result before saving instead of after.
 *   3. THE SAVE CARRIES persona AND quality, not just the text fields.
 *   4. THE COMPILED PROMPT IS SHOWN, and says so when unsaved edits are not
 *      in it yet — a preview that silently lags is worse than none.
 */

const { mockGet, mockSave, mockUpload, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSave: vi.fn(),
  mockUpload: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('../../../../_lib/agentIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agentIdentity')>()),
  getAgentIdentity: mockGet,
  saveAgentIdentity: mockSave,
  uploadAgentAvatar: mockUpload,
  deleteAgentAvatar: mockDelete,
}));

function dto(
  overrides: Partial<AgentIdentityDto['identity']> = {},
  top: Partial<Omit<AgentIdentityDto, 'identity' | 'resolved'>> = {},
): AgentIdentityDto {
  return {
    slug: 'sales',
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
      display_name: 'Sales Agent',
      short_description: null,
      long_description: null,
      instructions: null,
      accent_color: null,
      has_avatar: false,
    },
    composed_prompt: null,
    composed_family: null,
    ...top,
  };
}

/** Pick an archetype in the shared gallery (#2049) and apply it. */
async function applyArchetype(id: string): Promise<void> {
  await userEvent.click(screen.getByTestId(`gallery-card-${id}`));
  await userEvent.click(screen.getByTestId('gallery-apply'));
  // The gallery applies in a transition and closes once the value is set.
  await waitFor(() => expect(screen.queryByTestId('persona-template-gallery')).toBeNull());
}

async function openTab(id: 'character' | 'boundaries' | 'prompt'): Promise<void> {
  await userEvent.click(await screen.findByTestId(`agent-identity-tab-${id}`));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AgentIdentity — character (#914)', () => {
  it('renders the full persona designer on the character tab', async () => {
    mockGet.mockResolvedValue(dto());
    renderWithIntl(<AgentIdentity slug="sales" />);
    await openTab('character');

    // Radar + the eight core sliders; the four extended ones stay collapsed.
    expect(screen.getByTestId('persona-radar')).toBeTruthy();
    expect(screen.getByTestId('dimension-slider-directness')).toBeTruthy();
    expect(screen.getByTestId('dimension-slider-formality')).toBeTruthy();
    expect(screen.queryByTestId('dimension-slider-drama')).toBeNull();

    await userEvent.click(screen.getByTestId('agent-persona-extended-toggle'));
    expect(screen.getByTestId('dimension-slider-drama')).toBeTruthy();
  });

  it('applies an archetype to the axes without a round trip', async () => {
    mockGet.mockResolvedValue(dto());
    renderWithIntl(<AgentIdentity slug="sales" />);
    await openTab('character');

    await userEvent.click(screen.getByTestId('agent-persona-template-toggle'));
    await applyArchetype('customer-service');

    // The badge names the applied archetype, and nothing was saved yet: the
    // operator can still look at it and change their mind.
    expect(
      screen.getByTestId('agent-persona-template-badge').textContent,
    ).toContain('Customer Service');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('applies a culture preset through the shared dropdown into the save (#2049)', async () => {
    mockGet.mockResolvedValue(dto({ persona: { axes: { directness: 50, warmth: 50 } } }));
    mockSave.mockResolvedValue({ ...dto(), republish: 'not_needed' });
    renderWithIntl(<AgentIdentity slug="sales" />);
    await openTab('character');

    await userEvent.selectOptions(screen.getByTestId('culture-preset-select'), 'saas-startup');
    expect(screen.getByTestId('culture-diff-directness').textContent).toMatch(/50.*75/);
    await userEvent.click(screen.getByTestId('culture-confirm-apply'));
    await waitFor(() => expect(screen.queryByTestId('culture-confirm-modal')).toBeNull());
    expect(mockSave).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const payload = mockSave.mock.calls[0]?.[1] as { persona: { axes: Record<string, number> } };
    expect(payload.persona.axes.directness).toBe(75);
    expect(payload.persona.axes.warmth).toBe(55);
  });

  it('replaces the axes when switching to another archetype (#1897)', async () => {
    mockGet.mockResolvedValue(dto());
    mockSave.mockResolvedValue({ ...dto(), republish: 'not_needed' });
    renderWithIntl(<AgentIdentity slug="sales" />);
    await openTab('character');

    await userEvent.click(screen.getByTestId('agent-persona-template-toggle'));
    await applyArchetype('research-analyst');
    await userEvent.click(screen.getByTestId('agent-persona-template-toggle'));
    await applyArchetype('customer-service');
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const payload = mockSave.mock.calls[0]?.[1] as {
      persona: { template?: string; axes?: Record<string, number> } | null;
    };
    expect(payload.persona?.template).toBe('customer-service');
    expect(payload.persona?.axes).toEqual(
      getPersonaTemplate('customer-service')?.axes,
    );
  });

  it('keeps an edit made on another tab in the single save', async () => {
    mockGet.mockResolvedValue(dto());
    mockSave.mockResolvedValue({ ...dto(), republish: 'not_needed' });
    renderWithIntl(<AgentIdentity slug="sales" />);

    // Type a name on the profile tab …
    await userEvent.type(
      await screen.findByLabelText('Display name'),
      'Vertrieb',
    );
    // … pick an archetype on the character tab …
    await openTab('character');
    await userEvent.click(screen.getByTestId('agent-persona-template-toggle'));
    await applyArchetype('customer-service');
    // … tick a boundary on the limits tab …
    await openTab('boundaries');
    await userEvent.click(screen.getByTestId('agent-boundary-no-pii'));
    // … and save once.
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const payload = mockSave.mock.calls[0]?.[1] as {
      display_name: string | null;
      persona: { template?: string; axes?: Record<string, number> } | null;
      quality: { boundaries?: { presets?: string[] } } | null;
    };
    expect(payload.display_name).toBe('Vertrieb');
    expect(payload.persona?.template).toBe('customer-service');
    expect(Object.keys(payload.persona?.axes ?? {}).length).toBeGreaterThan(0);
    expect(payload.quality?.boundaries?.presets).toEqual(['no-pii']);
  });

  it('sends null instead of an empty document when nothing was authored', async () => {
    mockGet.mockResolvedValue(dto());
    mockSave.mockResolvedValue({ ...dto(), republish: 'not_needed' });
    renderWithIntl(<AgentIdentity slug="sales" />);

    await userEvent.type(await screen.findByLabelText('Display name'), 'V');
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const payload = mockSave.mock.calls[0]?.[1] as {
      persona: unknown;
      quality: unknown;
    };
    expect(payload.persona).toBeNull();
    expect(payload.quality).toBeNull();
  });

  it('shows the compiled prompt and warns while it is behind the form', async () => {
    mockGet.mockResolvedValue(
      dto({}, { composed_prompt: '<persona>\nvery direct\n</persona>' }),
    );
    renderWithIntl(<AgentIdentity slug="sales" />);
    await openTab('prompt');

    expect(
      screen.getByTestId('agent-identity-composed-prompt').textContent,
    ).toContain('very direct');

    // An unsaved edit is NOT in the compiled prompt — saying so beats
    // showing a preview that quietly lags behind the sliders.
    await openTab('character');
    await userEvent.click(screen.getByTestId('agent-persona-template-toggle'));
    await applyArchetype('customer-service');
    await openTab('prompt');
    expect(screen.getByText(/Unsaved changes are not in here yet/)).toBeTruthy();
  });

  it('#1890 — shows the running agent\'s identity head and the real block order', async () => {
    mockGet.mockResolvedValue(
      dto(
        {},
        {
          composed_prompt: '## Boundaries\n- No legal advice.',
          identity_prompt:
            'Du heißt Omi.\n\n## Boundaries\n- No legal advice.\n\nSprache: Antworte immer auf Deutsch.',
        },
      ),
    );
    renderWithIntl(<AgentIdentity slug="sales" />);
    await openTab('prompt');

    const text = screen.getByTestId('agent-identity-composed-prompt').textContent ?? '';
    expect(text).toContain('Du heißt Omi.');
    expect(text).toContain('Sprache:');
    expect(screen.queryByTestId('agent-identity-prompt-not-running')).toBeNull();
    // The hint no longer claims the conversation context comes first.
    expect(screen.queryByText(/two blocks can come before it/)).toBeNull();
    expect(screen.getByText(/only the Quality Guard plugin's rules come before it/)).toBeTruthy();
  });

  it('#1890 — says so when the agent is not running and only its own part is known', async () => {
    mockGet.mockResolvedValue(dto({}, { composed_prompt: '## Boundaries\n- x' }));
    renderWithIntl(<AgentIdentity slug="sales" />);
    await openTab('prompt');

    expect(screen.getByTestId('agent-identity-prompt-not-running')).toBeTruthy();
    expect(
      screen.getByTestId('agent-identity-composed-prompt').textContent,
    ).toContain('## Boundaries');
  });

  it('explains the empty prompt rather than showing an empty box', async () => {
    mockGet.mockResolvedValue(dto());
    renderWithIntl(<AgentIdentity slug="sales" />);
    await openTab('prompt');

    expect(
      screen.getByTestId('agent-identity-composed-prompt').textContent,
    ).toContain('platform-wide default');
  });

  it('surfaces boundary presets the server could not resolve', async () => {
    mockGet.mockResolvedValue(
      dto({ quality: { boundaries: { presets: ['from-the-future'], custom: [] } } }),
    );
    renderWithIntl(<AgentIdentity slug="sales" />);
    await openTab('boundaries');

    // A rule that silently stopped applying is worse than one that never
    // existed.
    expect(
      screen.getByTestId('agent-boundaries-unknown').textContent,
    ).toContain('from-the-future');
  });
});
