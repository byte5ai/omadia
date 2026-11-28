import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CredentialAskDto, CredentialDto } from '../../../_lib/adminCredentials';
import { renderWithIntl } from '../../../_lib/test-utils';
import AdminCredentialsPage from '../page';

/**
 * #2320 — Admin → Credentials wires the three server reads
 * (`/credentials`, `/credential-asks/pending`, `/credential-asks/mine`) and
 * the owner actions to the right endpoints; revoke needs a second click and
 * shows only where the server said `can_revoke`.
 */

const fetchMock = vi.fn();

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const personal: CredentialDto = {
  id: 'cred-1',
  name: 'alice-github',
  kind: 'personal',
  owner: 'user:alice',
  broker: null,
  created_by: 'alice',
  created_at: '2026-11-01T08:00:00.000Z',
  revoked_at: null,
  revoked_by: null,
  can_revoke: true,
};

const foreign: CredentialDto = { ...personal, id: 'cred-2', name: 'carol-jira', owner: 'user:carol', can_revoke: false };

const ask: CredentialAskDto = {
  id: 'ask-1',
  credential_id: 'cred-1',
  requester: 'bob',
  owner: 'alice',
  purpose: 'sync issues',
  mode: 'standing',
  requested_grant_expires_at: null,
  ask_expires_at: '2026-11-29T08:00:00.000Z',
  status: 'pending',
  created_at: '2026-11-28T08:00:00.000Z',
  resolved_at: null,
  resolved_by: null,
  grant_id: null,
};

function route(url: string, init?: RequestInit): Response {
  const path = new URL(url, 'http://localhost').pathname;
  const method = init?.method ?? 'GET';
  if (method === 'GET' && path === '/bot-api/v1/admin/credentials') return respond({ credentials: [personal, foreign] });
  if (path === '/bot-api/v1/admin/credential-asks/pending') return respond({ asks: [ask] });
  if (path === '/bot-api/v1/admin/credential-asks/mine') return respond({ asks: [] });
  if (method === 'POST') return respond({ ok: true });
  return respond({ code: 'unexpected' }, 500);
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => route(url, init));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function postedPaths(): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url]) => new URL(url as string, 'http://localhost').pathname);
}

describe('<AdminCredentialsPage />', () => {
  it('renders the inbox with the credential name and the keychain', async () => {
    renderWithIntl(<AdminCredentialsPage />);
    expect(await screen.findByText('sync issues')).toBeInTheDocument();
    expect(screen.getAllByText('alice-github').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('carol-jira')).toBeInTheDocument();
    expect(screen.getByText('You have not asked for a credential.')).toBeInTheDocument();
    // Only the own credential offers revoke.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  });

  it('approves an ask through the owner endpoint', async () => {
    renderWithIntl(<AdminCredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(postedPaths()).toContain('/bot-api/v1/admin/credential-asks/ask-1/approve'));
  });

  it('revokes a credential only after the confirm click', async () => {
    renderWithIntl(<AdminCredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(postedPaths()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke for good' }));
    await waitFor(() => expect(postedPaths()).toContain('/bot-api/v1/admin/credentials/cred-1/revoke'));
  });

  it('shows catalog copy, not the server body, for a forbidden answer', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? respond({ code: 'credential_ask.forbidden', message: 'raw server text' }, 403)
        : route(url, init),
    );
    renderWithIntl(<AdminCredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('Only the owner of the credential can answer this ask.')).toBeInTheDocument();
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
  });
});
