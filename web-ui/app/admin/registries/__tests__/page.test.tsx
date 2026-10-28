import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import AdminRegistriesPage from '../page';

/**
 * #1482 — Admin · Registries shows the outcome of each registry's last index
 * fetch, so a failing source is visible where it is configured.
 */

const fetchMock = vi.fn();

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('<AdminRegistriesPage /> status (#1482)', () => {
  it('shows reachable, failing and unchecked registries', async () => {
    fetchMock.mockResolvedValue(
      respond({
        registries: [
          {
            name: 'omadia-public',
            url: 'https://hub.omadia.ai',
            has_token: false,
            status: {
              name: 'omadia-public',
              ok: true,
              checked_at: '2026-10-28T08:00:00.000Z',
              plugin_count: 12,
            },
          },
          {
            name: 'broken',
            url: 'https://hub.example/nope',
            has_token: false,
            status: {
              name: 'broken',
              ok: false,
              checked_at: '2026-10-28T08:00:00.000Z',
              error: { code: 'registry.index_http', message: 'broken: GET /registry/index.json → 404' },
            },
          },
          { name: 'fresh', url: 'https://hub.example', has_token: false },
        ],
      }),
    );
    renderWithIntl(<AdminRegistriesPage />);

    expect(await screen.findByText('Reachable · 12 plugins')).toBeTruthy();
    expect(screen.getByText('Unreachable')).toBeTruthy();
    // The reason is a catalog line keyed on the code; the English server
    // message is only the technical detail behind it.
    expect(
      screen.getByText('Last check failed. It answered with an HTTP error.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Technical detail: broken: GET /registry/index.json → 404'),
    ).toBeTruthy();
    expect(screen.getByText('Not checked yet')).toBeTruthy();
  });
});
