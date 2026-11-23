import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { ApiError } from '../../../../_lib/api';
import type { ChannelIdentitiesDto } from '../../../../_lib/agentChannelIdentities';
import { AgentChannelIdentities } from '../_components/AgentChannelIdentities';

/**
 * Spec 2042 §5.3 — the agent's own bot per channel. Pinned: the fields come
 * from the plugin, a secret is a password input and is gone after saving,
 * an error code renders catalogue copy (never the raw body), and removing
 * asks first.
 */

const { mockGet, mockSet, mockRemove } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockRemove: vi.fn(),
}));

vi.mock('../../../../_lib/agentChannelIdentities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agentChannelIdentities')>()),
  getAgentChannelIdentities: mockGet,
  setAgentChannelIdentity: mockSet,
  removeAgentChannelIdentity: mockRemove,
}));

const TOKEN_FIELD = {
  key: 'bot_token',
  label: { en: 'Bot token', de: 'Bot-Token' },
  help: { en: 'From @BotFather' },
  secret: true,
};

function withoutBot(): ChannelIdentitiesDto {
  return { agent: 'mira', channels: [{ channelType: 'telegram', fields: [TOKEN_FIELD], identity: null }] };
}

function withBot(): ChannelIdentitiesDto {
  return {
    agent: 'mira',
    channels: [
      {
        channelType: 'telegram',
        fields: [TOKEN_FIELD],
        identity: {
          channelType: 'telegram',
          channelKey: 'tg:12345',
          externalRef: '@mira_bot',
          displayName: 'Mira',
          createdAt: '2026-11-20T10:00:00.000Z',
          status: { state: 'running' },
        },
      },
    ],
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockReset();
  mockRemove.mockReset();
});

describe('AgentChannelIdentities', () => {
  it('offers the plugin-declared fields, with a secret as a password input', async () => {
    mockGet.mockResolvedValue(withoutBot());
    renderWithIntl(<AgentChannelIdentities slug="mira" />);
    const input = await screen.findByLabelText(/Bot token/);
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByText('From @BotFather')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect bot/ })).toBeDisabled();
  });

  it('sends the credentials once and clears the form', async () => {
    mockGet.mockResolvedValueOnce(withoutBot()).mockResolvedValueOnce(withBot());
    mockSet.mockResolvedValue({ ok: true, identity: withBot().channels[0]!.identity });
    renderWithIntl(<AgentChannelIdentities slug="mira" />);
    await userEvent.type(await screen.findByLabelText(/Bot token/), '123:abc');
    await userEvent.click(screen.getByRole('button', { name: /Connect bot/ }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('mira', 'telegram', { bot_token: '123:abc' }));
    expect(await screen.findByText(/@mira_bot/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Bot token/)).not.toBeInTheDocument();
  });

  it('renders a known error code from the catalogue, not the raw body', async () => {
    mockGet.mockResolvedValue(withoutBot());
    mockSet.mockRejectedValue(
      new ApiError(409, 'PUT failed: 409', JSON.stringify({ error: 'bot_taken', message: 'raw server text' })),
    );
    renderWithIntl(<AgentChannelIdentities slug="mira" />);
    await userEvent.type(await screen.findByLabelText(/Bot token/), '123:abc');
    await userEvent.click(screen.getByRole('button', { name: /Connect bot/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This bot belongs to another agent.');
    expect(screen.queryByText(/raw server text/)).not.toBeInTheDocument();
  });

  it('removes the bot only after confirmation', async () => {
    mockGet.mockResolvedValueOnce(withBot()).mockResolvedValueOnce(withoutBot());
    mockRemove.mockResolvedValue({ ok: true, released: true });
    renderWithIntl(<AgentChannelIdentities slug="mira" />);
    const card = await screen.findByTestId('channel-identity-telegram');
    await userEvent.click(within(card).getByRole('button', { name: /Remove bot/ }));
    expect(mockRemove).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /Remove bot/ }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('mira', 'telegram'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says so when the plugin was not active to forget the token', async () => {
    mockGet.mockResolvedValueOnce(withBot()).mockResolvedValueOnce(withoutBot());
    mockRemove.mockResolvedValue({ ok: true, released: false });
    renderWithIntl(<AgentChannelIdentities slug="mira" />);
    const card = await screen.findByTestId('channel-identity-telegram');
    await userEvent.click(within(card).getByRole('button', { name: /Remove bot/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /Remove bot/ }));
    expect(await screen.findByRole('status')).toHaveTextContent(/revoke the token/);
  });

  it('says so when no channel plugin runs agent bots', async () => {
    mockGet.mockResolvedValue({ agent: 'mira', channels: [] });
    renderWithIntl(<AgentChannelIdentities slug="mira" />);
    expect(await screen.findByText(/No active channel plugin/)).toBeInTheDocument();
  });
});
