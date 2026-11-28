import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SandboxDto } from '../../../_lib/adminSandboxes';
import { renderWithIntl } from '../../../_lib/test-utils';
import AdminSandboxesPage from '../page';

/**
 * #2320 — Admin → Sandboxes lists `GET /v1/admin/sandboxes`, previews and
 * runs the idle sweep through `POST /reap` (hours → minutes), tears one
 * sandbox down through `POST /teardown`, and explains a 503 (no database).
 */

const fetchMock = vi.fn();

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const sandbox: SandboxDto = {
  scope_key: 'personal:alice',
  backend: 'docker',
  sandbox_ref: 'omadia-sbx-abc',
  persistent: false,
  egress: false,
  created_at: '2026-11-20T08:00:00.000Z',
  last_used_at: '2026-11-26T08:00:00.000Z',
};

const LIST = {
  sandboxes: [sandbox],
  reaper: { default_idle_minutes: 1440, min_idle_minutes: 5, max_idle_minutes: 43200 },
};

function posts(): Array<{ path: string; body: unknown }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({
      path: new URL(url as string, 'http://localhost').pathname,
      body: JSON.parse((init as RequestInit).body as string) as unknown,
    }));
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return respond(LIST);
    if (url.endsWith('/reap')) {
      const body = JSON.parse(init.body as string) as { dryRun: boolean };
      return respond(body.dryRun ? { dry_run: true, candidates: ['personal:alice'] } : { dry_run: false, reaped: ['personal:alice'], failed: [] });
    }
    return respond({ ok: true });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('<AdminSandboxesPage />', () => {
  it('lists sandboxes with their profile', async () => {
    renderWithIntl(<AdminSandboxesPage />);
    expect(await screen.findByText('personal:alice')).toBeInTheDocument();
    expect(screen.getByText('removable when idle · no network')).toBeInTheDocument();
  });

  it('previews the sweep in minutes and lists the candidates', async () => {
    renderWithIntl(<AdminSandboxesPage />);
    fireEvent.change(await screen.findByLabelText('Idle for more than (hours)'), { target: { value: '48' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('1 sandbox would be removed:')).toBeInTheDocument();
    expect(posts()).toEqual([{ path: '/bot-api/v1/admin/sandboxes/reap', body: { idleMinutes: 2880, dryRun: true } }]);
  });

  it('sweeps only after the confirm click', async () => {
    renderWithIntl(<AdminSandboxesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sweep' }));
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove idle sandboxes' }));
    await waitFor(() =>
      expect(posts()).toEqual([{ path: '/bot-api/v1/admin/sandboxes/reap', body: { idleMinutes: 1440, dryRun: false } }]),
    );
  });

  it('tears one sandbox down by scope key', async () => {
    renderWithIntl(<AdminSandboxesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove with its files' }));
    await waitFor(() =>
      expect(posts()).toEqual([{ path: '/bot-api/v1/admin/sandboxes/teardown', body: { scopeKey: 'personal:alice' } }]),
    );
  });

  it('explains a missing database', async () => {
    fetchMock.mockResolvedValue(respond({ code: 'sandbox_admin.unavailable' }, 503));
    renderWithIntl(<AdminSandboxesPage />);
    expect(await screen.findByText(/needs the Postgres database/)).toBeInTheDocument();
  });
});
