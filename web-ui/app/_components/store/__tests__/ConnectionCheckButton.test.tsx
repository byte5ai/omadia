import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithIntl } from '../../../_lib/test-utils';
import { ConnectionCheckButton } from '../ConnectionCheckButton';

/**
 * Issue #1453 — the operator can ask "do these credentials work?" without
 * saving a field to force a reactivation, and without sending a chat message.
 *
 * Every verdict the route can answer has to read as what it is. An
 * inconclusive probe must never be presented as a healthy connection — that
 * conflation is the whole bug.
 */

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConnectionCheckButton', () => {
  it('posts to the verify route for this plugin', async () => {
    respondWith({ status: 'connected' });
    renderWithIntl(<ConnectionCheckButton pluginId="@omadia/integration-odoo" />);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/bot-api/v1/admin/runtime/installed/%40omadia%2Fintegration-odoo/verify',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('reports a working connection', async () => {
    respondWith({ status: 'connected', title: 'Verbunden' });
    renderWithIntl(<ConnectionCheckButton pluginId="p" />);

    await userEvent.click(screen.getByRole('button'));

    expect(await screen.findByText(/Connection works/i)).toBeTruthy();
  });

  it('reports a refused credential with the plugin’s own detail', async () => {
    respondWith({
      status: 'rejected',
      cause: 'protocol_auth_failure',
      title: 'Nicht verbunden',
      detail: 'Odoo hat den API-Key abgelehnt',
    });
    renderWithIntl(<ConnectionCheckButton pluginId="p" />);

    await userEvent.click(screen.getByRole('button'));

    expect(await screen.findByText(/credentials were refused/i)).toBeTruthy();
    expect(screen.getByText(/Odoo hat den API-Key abgelehnt/)).toBeTruthy();
  });

  it('never presents an inconclusive probe as a working connection', async () => {
    respondWith({ status: 'inconclusive', reason: 'timed_out' });
    renderWithIntl(<ConnectionCheckButton pluginId="p" />);

    await userEvent.click(screen.getByRole('button'));

    const line = await screen.findByText(/could not be checked/i);
    expect(line).toBeTruthy();
    expect(screen.queryByText(/Connection works/i)).toBeNull();
  });

  it('says so when the plugin ships no check at all', async () => {
    respondWith({ status: 'inconclusive', reason: 'no_probe' });
    renderWithIntl(<ConnectionCheckButton pluginId="p" />);

    await userEvent.click(screen.getByRole('button'));

    expect(
      await screen.findByText(/does not support a connection check/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Connection works/i)).toBeNull();
  });

  it('surfaces a refusal from the route itself', async () => {
    respondWith({ code: 'runtime.not_active', message: 'not active' }, 409);
    renderWithIntl(<ConnectionCheckButton pluginId="p" />);

    await userEvent.click(screen.getByRole('button'));

    expect(await screen.findByText(/could not be checked/i)).toBeTruthy();
  });

  it('survives a network failure without claiming anything', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    renderWithIntl(<ConnectionCheckButton pluginId="p" />);

    await userEvent.click(screen.getByRole('button'));

    expect(await screen.findByText(/could not be checked/i)).toBeTruthy();
  });
});
