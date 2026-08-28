import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type { AgentIdentityDto } from '../../../../_lib/agentIdentity';
import { AgentIdentity } from '../_components/AgentIdentity';

/**
 * #914 — the agent's own identity section.
 *
 * This slot used to hold "Persona and behaviour", whose entire content was a
 * deep link into the Agent Builder. These tests pin what replaced it:
 *
 *   1. EMPTY MEANS INHERIT, VISIBLY. An agent with no authored identity shows
 *      empty fields whose placeholders name what would be inherited — not a
 *      form pre-filled with values that were never authored, which would turn
 *      the first save into an accidental authoring of all of them.
 *   2. A BLANK FIELD CLEARS. Submitting an empty field sends `null`, the
 *      "inherit" signal, never `''`.
 *   3. THE TEAMS CONSEQUENCE IS STATED. A save on an installed agent says the
 *      package is being republished; a save on one without an installed app
 *      says THAT, instead of implying a publish that cannot happen.
 *   4. NOTHING LINKS TO THE BUILDER. The regression this issue exists to
 *      prevent is the link creeping back in.
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

function dto(overrides: Partial<AgentIdentityDto['identity']> = {}): AgentIdentityDto {
  return {
    slug: 'sales',
    identity: {
      display_name: null,
      short_description: null,
      long_description: null,
        instructions: null,
      accent_color: null,
      revision: 1,
      avatar: null,
      updated_at: null,
      ...overrides,
    },
    resolved: {
      display_name: overrides.display_name ?? 'Sales Agent',
      short_description: overrides.short_description ?? 'Sells',
      long_description: null,
        instructions: null,
      accent_color: null,
      has_avatar: overrides.avatar != null,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AgentIdentity (#914)', () => {
  it('shows the inherited name as a placeholder rather than as an authored value', async () => {
    mockGet.mockResolvedValue(dto());
    renderWithIntl(<AgentIdentity slug="sales" />);

    const name = await screen.findByLabelText('Display name');
    expect((name as HTMLInputElement).value).toBe('');
    expect((name as HTMLInputElement).placeholder).toBe('Sales Agent');
    // The resolved name is still shown, so the operator can see what the
    // empty field means without saving to find out.
    expect(screen.getByText('Sales Agent')).toBeTruthy();
  });

  it('sends the edited fields and reports the queued republish', async () => {
    mockGet.mockResolvedValue(dto());
    mockSave.mockResolvedValue({
      ...dto({ display_name: 'Vertrieb', revision: 2 }),
      republish: 'queued',
    });
    renderWithIntl(<AgentIdentity slug="sales" />);

    const name = await screen.findByLabelText('Display name');
    await userEvent.type(name, 'Vertrieb');
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave.mock.calls[0]?.[1]).toMatchObject({
      display_name: 'Vertrieb',
      // Untouched fields go back as null — "inherit", not "cleared to empty".
      short_description: null,
      instructions: null,
    });
    expect(
      (await screen.findByTestId('agent-identity-republish')).textContent,
    ).toContain('Republishing the Teams package');
  });

  it('says nothing was published when the agent has no installed Teams app', async () => {
    mockGet.mockResolvedValue(dto());
    mockSave.mockResolvedValue({
      ...dto({ display_name: 'Vertrieb', revision: 2 }),
      republish: 'no_installed_app',
    });
    renderWithIntl(<AgentIdentity slug="sales" />);

    await userEvent.type(
      await screen.findByLabelText('Display name'),
      'Vertrieb',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));

    expect(
      (await screen.findByTestId('agent-identity-republish')).textContent,
    ).toContain('no installed Teams app');
  });

  it('keeps the save button inert until something actually changed', async () => {
    mockGet.mockResolvedValue(dto({ display_name: 'Vertrieb' }));
    renderWithIntl(<AgentIdentity slug="sales" />);

    const save = await screen.findByRole('button', { name: 'Save identity' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Full description'), 'More');
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no avatar removal while there is no avatar', async () => {
    mockGet.mockResolvedValue(dto());
    renderWithIntl(<AgentIdentity slug="sales" />);

    expect(
      await screen.findByRole('button', { name: 'Upload a picture' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove the picture' })).toBeNull();
  });

  it('renders the avatar preview and its removal once one exists', async () => {
    mockGet.mockResolvedValue(
      dto({ avatar: { etag: 'abc123def456ghij', url: '/api/v1/operator/agents/sales/identity/avatar' } }),
    );
    renderWithIntl(<AgentIdentity slug="sales" />);

    const img = (await screen.findByTestId('agent-identity-avatar')).querySelector(
      'img',
    );
    // The etag is in the URL: without it the browser keeps showing the
    // picture that was just replaced.
    expect(img?.getAttribute('src')).toBe(
      '/bot-api/v1/operator/agents/sales/identity/avatar?v=abc123def456ghij',
    );
    expect(screen.getByRole('button', { name: 'Remove the picture' })).toBeTruthy();
  });

  it('localizes a failure instead of printing the raw body', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    renderWithIntl(<AgentIdentity slug="sales" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Request failed');
  });

  it('links nowhere near the Agent Builder', async () => {
    mockGet.mockResolvedValue(dto());
    const { container } = renderWithIntl(<AgentIdentity slug="sales" />);
    await screen.findByLabelText('Display name');

    expect(container.querySelectorAll('a[href*="builder"]').length).toBe(0);
    expect(container.textContent).not.toContain('Agent Builder');
  });
});
