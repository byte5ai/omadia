import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CredentialAskDto, CredentialDto } from '../../../_lib/adminCredentials';
import { renderWithIntl } from '../../../_lib/test-utils';
import AdminCredentialsPage from '../page';

/**
 * #2320 — Admin → Credentials lists `/credentials` with revocation (second
 * click, only where the server said `can_revoke`) and links the ask inbox
 * with the pending count.
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
  it('renders the keychain and links the inbox with the pending count', async () => {
    renderWithIntl(<AdminCredentialsPage />);
    expect(await screen.findByText('alice-github')).toBeInTheDocument();
    expect(screen.getByText('carol-jira')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open the ask inbox — 1 ask is waiting for you' });
    expect(link).toHaveAttribute('href', '/admin/credentials/asks');
    // Only the own credential offers revoke.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  });

  it('revokes a credential only after the confirm click', async () => {
    renderWithIntl(<AdminCredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(postedPaths()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke for good' }));
    await waitFor(() => expect(postedPaths()).toContain('/bot-api/v1/admin/credentials/cred-1/revoke'));
  });

  it('loads the grants of a credential on demand', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith('/cred-1/grants')
        ? respond({ credential: personal, grants: [], can_revoke_grants: true })
        : route(url, init),
    );
    renderWithIntl(<AdminCredentialsPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Grants' }))[0] as HTMLElement);
    expect(await screen.findByText('Nobody holds a grant for this credential.')).toBeInTheDocument();
  });
});
