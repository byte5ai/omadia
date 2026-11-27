import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import { renderWithIntl } from '../../../../_lib/test-utils';
import type { AgentIdentityDto } from '../../../../_lib/agentIdentity';
import { AgentDetailTabs } from '../_components/AgentDetailTabs';
import { AgentIdentity } from '../_components/AgentIdentity';

/**
 * #1889 / ADR-0216 — the identity editor must not lose an operator's edits:
 *
 *   1. every save carries the revision the form was read at, and a 409 says
 *      "changed elsewhere" in the operator's language with a reload offer;
 *   2. an avatar upload or removal leaves unsaved field edits in place;
 *   3. removing the avatar asks first;
 *   4. leaving the Identity tab with unsaved input asks first.
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

const AVATAR = { etag: 'abc123def456ghij', url: '/api/v1/operator/agents/sales/identity/avatar' };

function dto(overrides: Partial<AgentIdentityDto['identity']> = {}): AgentIdentityDto {
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
      revision: 8,
      avatar: null,
      updated_at: null,
      ...overrides,
    },
    composed_prompt: null,
    composed_family: null,
    resolved: {
      display_name: overrides.display_name ?? 'Sales Agent',
      short_description: overrides.short_description ?? null,
      long_description: null,
      instructions: null,
      accent_color: null,
      has_avatar: overrides.avatar != null,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('AgentIdentity optimistic concurrency (#1889)', () => {
  it('sends the revision the form was read at', async () => {
    mockGet.mockResolvedValue(dto());
    mockSave.mockResolvedValue({ ...dto({ short_description: 'Sells', revision: 9 }), republish: 'not_needed' });
    renderWithIntl(<AgentIdentity slug="sales" />);

    await userEvent.type(await screen.findByLabelText('Short description'), 'Sells');
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave.mock.calls[0]?.[1]).toMatchObject({ expected_revision: 8 });
  });

  it('shows a localized conflict with a reload, and keeps the edit until reloaded', async () => {
    mockGet.mockResolvedValueOnce(dto()).mockResolvedValueOnce(dto({ short_description: 'From tab A', revision: 9 }));
    mockSave.mockRejectedValue(
      new ApiError(
        409,
        'PUT failed: 409',
        JSON.stringify({
          error: 'identity_revision_conflict',
          code: 'operator_agents.identity_revision_conflict',
          message: 'the agent identity is at revision 9, not the expected 8',
        }),
      ),
    );
    renderWithIntl(<AgentIdentity slug="sales" />, { locale: 'de' });

    const accent = await screen.findByLabelText('Akzentfarbe');
    await userEvent.type(accent, '#123456');
    await userEvent.click(screen.getByRole('button', { name: 'Identität speichern' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('an anderer Stelle geändert');
    expect(alert.textContent).not.toContain('revision 9');
    expect(accent).toHaveValue('#123456');

    await userEvent.click(screen.getByTestId('agent-identity-reload'));
    await waitFor(() => expect(screen.getByLabelText('Kurzbeschreibung')).toHaveValue('From tab A'));
    expect(screen.queryByTestId('agent-identity-reload')).toBeNull();
  });

  it('keeps unsaved field edits across an avatar upload', async () => {
    mockGet.mockResolvedValue(dto());
    mockUpload.mockResolvedValue({ ...dto({ avatar: AVATAR, revision: 9 }), republish: 'not_needed' });
    mockSave.mockResolvedValue({ ...dto({ short_description: 'Draft', revision: 10 }), republish: 'not_needed' });
    renderWithIntl(<AgentIdentity slug="sales" />);

    const short = await screen.findByLabelText('Short description');
    await userEvent.type(short, 'Draft');
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('Upload a picture', { selector: 'input' }), file);

    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: 'Remove the picture' });
    expect(short).toHaveValue('Draft');

    // The page's own avatar write moved the revision by one: the save
    // baseline follows it, so the next save is not a false conflict.
    await userEvent.click(screen.getByRole('button', { name: 'Save identity' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave.mock.calls[0]?.[1]).toMatchObject({ short_description: 'Draft', expected_revision: 9 });
  });

  it('asks before removing the avatar and removes nothing when declined', async () => {
    mockGet.mockResolvedValue(dto({ avatar: AVATAR }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithIntl(<AgentIdentity slug="sales" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Remove the picture' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('Agent detail tabs guard unsaved identity edits (#1889)', () => {
  function renderTabs(): void {
    renderWithIntl(
      <AgentDetailTabs
        panels={{
          identity: () => <AgentIdentity slug="sales" />,
          model: () => <div data-testid="model-panel" />,
        }}
      />,
    );
  }

  it('asks before leaving with unsaved input and stays when declined', async () => {
    mockGet.mockResolvedValue(dto());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderTabs();

    await userEvent.type(await screen.findByLabelText('Short description'), 'Draft');
    await userEvent.click(screen.getByTestId('agent-detail-tab-model'));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('model-panel')).toBeNull();
    expect(screen.getByLabelText('Short description')).toHaveValue('Draft');
  });

  it('Back with unsaved input asks, and a declined leave keeps the tab and restores the URL', async () => {
    window.history.replaceState(null, '', '/operator/agents/sales');
    mockGet.mockResolvedValue(dto());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderTabs();

    await userEvent.type(await screen.findByLabelText('Short description'), 'Draft');
    // What the browser does on Back: the URL already names the other tab.
    act(() => {
      window.history.replaceState(null, '', '/operator/agents/sales?tab=model');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('model-panel')).toBeNull();
    expect(screen.getByLabelText('Short description')).toHaveValue('Draft');
    expect(window.location.search).toBe('');
  });

  it('Back without unsaved input follows the URL without asking', async () => {
    window.history.replaceState(null, '', '/operator/agents/sales');
    mockGet.mockResolvedValue(dto());
    const confirm = vi.spyOn(window, 'confirm');
    renderTabs();
    await screen.findByLabelText('Short description');

    act(() => {
      window.history.replaceState(null, '', '/operator/agents/sales?tab=model');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('model-panel')).toBeInTheDocument();
  });

  it('leaves without asking when nothing is unsaved', async () => {
    mockGet.mockResolvedValue(dto());
    const confirm = vi.spyOn(window, 'confirm');
    renderTabs();

    await screen.findByLabelText('Short description');
    await userEvent.click(screen.getByTestId('agent-detail-tab-model'));

    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('model-panel')).toBeInTheDocument();
  });
});
