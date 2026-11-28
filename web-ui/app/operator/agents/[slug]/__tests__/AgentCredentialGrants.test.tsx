import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CredentialDto } from '../../../../_lib/adminCredentials';
import type { AgentCredentialGrantDto } from '../../../../_lib/agentCredentialGrants';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { AgentCredentialGrants } from '../_components/AgentCredentialGrants';

/**
 * #2320 / #2319 — an agent's credential grants against the operator routes
 * `GET|PUT|DELETE /v1/operator/agents/:slug/credential-grants[/:credentialId]`
 * (through the `/bot-api` proxy). The offer lists active keychain entries not
 * yet granted; removal needs the confirm click.
 */

const fetchMock = vi.fn();
const GRANTS = '/bot-api/v1/operator/agents/clara/credential-grants';

function respond(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BROKER = { host: 'api.example.com', injection_scheme: 'bearer', allowed_methods: ['GET'], path_prefixes: ['/'] };

function credential(over: Partial<CredentialDto>): CredentialDto {
  return {
    id: 'cred-x',
    name: 'x',
    kind: 'service',
    owner: null,
    broker: BROKER,
    created_by: 'alice',
    created_at: '2026-11-01T08:00:00.000Z',
    revoked_at: null,
    revoked_by: null,
    can_revoke: true,
    ...over,
  };
}

const notion = credential({ id: 'cred-notion', name: 'org-notion', broker: { ...BROKER, host: 'api.notion.com' } });
const jira = credential({ id: 'cred-jira', name: 'org-jira', broker: { ...BROKER, host: 'jira.example.com' } });
const gone = credential({ id: 'cred-gone', name: 'old-token', revoked_at: '2026-11-02T08:00:00.000Z' });

const granted: AgentCredentialGrantDto = {
  credentialId: 'cred-notion',
  name: 'org-notion',
  kind: 'service',
  host: 'api.notion.com',
  revoked: false,
  grantedBy: 'alice',
  grantedAt: '2026-11-20T08:00:00.000Z',
};

let grants: AgentCredentialGrantDto[] = [];

function route(url: string, init?: RequestInit): Response {
  const path = new URL(url, 'http://localhost').pathname;
  const method = init?.method ?? 'GET';
  if (method === 'GET' && path === GRANTS) return respond({ slug: 'clara', capability: 'credentialBroker@1', grants });
  if (method === 'GET' && path === '/bot-api/v1/admin/credentials') return respond({ credentials: [notion, jira, gone] });
  if (method === 'PUT' && path === `${GRANTS}/cred-jira`) return respond({ ...granted, credentialId: 'cred-jira' }, 201);
  if (method === 'PUT' && path === `${GRANTS}/cred-revoked`) return respond({ error: 'credential_revoked' }, 409);
  if (method === 'DELETE' && path === `${GRANTS}/cred-notion`) return respond(null, 204);
  return respond({ error: 'unexpected' }, 500);
}

beforeEach(() => {
  grants = [granted];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => route(url, init));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function calls(method: string): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method)
    .map(([url]) => new URL(url as string, 'http://localhost').pathname);
}

describe('<AgentCredentialGrants />', () => {
  it('lists the grants and offers only active, not yet granted credentials', async () => {
    renderWithIntl(<AgentCredentialGrants slug="clara" />);
    expect(await screen.findByText('org-notion')).toBeInTheDocument();
    expect(screen.getByText('api.notion.com')).toBeInTheDocument();
    const options = Array.from(screen.getByRole('combobox', { name: 'Grant a credential' }).querySelectorAll('option')).map(
      (o) => o.textContent,
    );
    expect(options).toEqual(['Choose a credential…', 'org-jira (host jira.example.com)']);
  });

  it('grants the chosen credential with PUT and reports the change', async () => {
    const onChanged = vi.fn();
    renderWithIntl(<AgentCredentialGrants slug="clara" onChanged={onChanged} />);
    await screen.findByText('org-notion');
    fireEvent.change(screen.getByRole('combobox', { name: 'Grant a credential' }), { target: { value: 'cred-jira' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(calls('PUT')).toEqual([`${GRANTS}/cred-jira`]));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('removes a grant only after the confirm click (DELETE, 204)', async () => {
    const onChanged = vi.fn();
    renderWithIntl(<AgentCredentialGrants slug="clara" onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(calls('DELETE')).toHaveLength(0);
    grants = [];
    fireEvent.click(screen.getByRole('button', { name: 'Remove grant' }));
    await waitFor(() => expect(calls('DELETE')).toEqual([`${GRANTS}/cred-notion`]));
    expect(await screen.findByText('This agent has no credential grants.')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows a catalog error for a refused grant, not the raw body', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET' && url.endsWith('/v1/admin/credentials')
        ? respond({ credentials: [credential({ id: 'cred-revoked', name: 'race' })] })
        : route(url, init),
    );
    renderWithIntl(<AgentCredentialGrants slug="clara" />);
    await screen.findByText('org-notion');
    fireEvent.change(screen.getByRole('combobox', { name: 'Grant a credential' }), { target: { value: 'cred-revoked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A revoked credential cannot be granted.');
  });
});
