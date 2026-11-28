import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import AdminPublishedAppsPage from '../page';

/**
 * #2320 — Admin → Published apps reads `GET /v1/admin/publish/apps` and, on
 * demand, `/apps/:appId/versions`; the live version is marked, a rolled-back
 * pointer reads as "newest is N", and a 503 explains the missing database.
 */

const fetchMock = vi.fn();

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/apps')) {
      return respond({
        apps: [
          { app_id: 'team-board', name: 'Team board', current_version: 2, latest_version: 3, version_count: 3, updated_at: '2026-11-28T10:00:00.000Z' },
        ],
      });
    }
    return respond({
      app_id: 'team-board',
      current_version: 2,
      versions: [
        { version: 3, name: 'Team board', entrypoint: 'server.js', dir_hash: 'abcdef0123456789', source_scope_key: 'personal:alice', created_at: '2026-11-28T10:00:00.000Z', current: false },
        { version: 2, name: 'Team board', entrypoint: 'server.js', dir_hash: '0123456789abcdef', source_scope_key: 'personal:alice', created_at: '2026-11-27T10:00:00.000Z', current: true },
      ],
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('<AdminPublishedAppsPage />', () => {
  it('lists apps and reads a rolled-back pointer', async () => {
    renderWithIntl(<AdminPublishedAppsPage />);
    expect(await screen.findByText('team-board')).toBeInTheDocument();
    expect(screen.getByText('Version 2 (newest is 3)')).toBeInTheDocument();
  });

  it('loads the version log on demand and marks the live version', async () => {
    renderWithIntl(<AdminPublishedAppsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Versions' }));
    expect(await screen.findByText('Version 3')).toBeInTheDocument();
    expect(screen.getByText('live').closest('li')).toHaveTextContent('Version 2');
    const paths = fetchMock.mock.calls.map(([url]) => new URL(url as string, 'http://localhost').pathname);
    expect(paths).toContain('/bot-api/v1/admin/publish/apps/team-board/versions');
  });

  it('explains a missing database', async () => {
    fetchMock.mockResolvedValue(respond({ code: 'publish_admin.unavailable' }, 503));
    renderWithIntl(<AdminPublishedAppsPage />);
    expect(await screen.findByText(/needs the Postgres database/)).toBeInTheDocument();
  });
});
