import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CredentialAskDto } from '../../../../_lib/adminCredentials';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { AskInboxView } from '../../_components/AskInboxView';
import AdminCredentialAsksPage from '../page';

/**
 * #2320 — the ask inbox at `/admin/credentials/asks`, the path the owner
 * notice of #2319 links to (`?ask=<id>`). Reads `/credential-asks/pending`
 * and `/mine`, answers through the owner endpoints, highlights the linked ask.
 */

const fetchMock = vi.fn();

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

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
  if (init?.method === 'POST') return respond({ ok: true });
  if (path.endsWith('/credential-asks/pending')) return respond({ asks: [ask] });
  if (path.endsWith('/credential-asks/mine')) return respond({ asks: [] });
  if (path.endsWith('/admin/credentials')) {
    return respond({ credentials: [{ id: 'cred-1', name: 'alice-github' }] });
  }
  return respond({ code: 'unexpected' }, 500);
}

function postedPaths(): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url]) => new URL(url as string, 'http://localhost').pathname);
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => route(url, init));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('/admin/credentials/asks', () => {
  it('passes a valid ?ask= id to the view and drops anything else', async () => {
    const ok = await AdminCredentialAsksPage({ searchParams: Promise.resolve({ ask: 'ask-1' }) });
    expect(ok.props).toEqual({ focusAskId: 'ask-1' });
    const bad = await AdminCredentialAsksPage({ searchParams: Promise.resolve({ ask: '<script>' }) });
    expect(bad.props).toEqual({ focusAskId: null });
    const many = await AdminCredentialAsksPage({ searchParams: Promise.resolve({ ask: ['a', 'b'] }) });
    expect(many.props).toEqual({ focusAskId: null });
  });

  it('renders the inbox with the credential name and highlights the linked ask', async () => {
    renderWithIntl(<AskInboxView focusAskId="ask-1" />);
    const purpose = await screen.findByText('sync issues');
    expect(screen.getByText('alice-github')).toBeInTheDocument();
    expect(purpose.closest('tr')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('You have not asked for a credential.')).toBeInTheDocument();
  });

  it('says so when the linked ask is not listed', async () => {
    renderWithIntl(<AskInboxView focusAskId="ask-gone" />);
    expect(await screen.findByText(/The linked ask is no longer listed/)).toBeInTheDocument();
  });

  it('approves through the owner endpoint', async () => {
    renderWithIntl(<AskInboxView focusAskId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(postedPaths()).toContain('/bot-api/v1/admin/credential-asks/ask-1/approve'));
  });

  it('shows catalog copy, not the server body, for a forbidden answer', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? respond({ code: 'credential_ask.forbidden', message: 'raw server text' }, 403)
        : route(url, init),
    );
    renderWithIntl(<AskInboxView focusAskId={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('Only the owner of the credential can answer this ask.')).toBeInTheDocument();
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
  });
});
