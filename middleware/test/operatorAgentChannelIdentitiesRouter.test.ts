/**
 * #2049 × spec 2042 §5.3 — the draft agent of a Plugin Builder preview never
 * gets a bot of its own: no plugin is asked, nothing is provisioned. Reading
 * and removing stay allowed.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { createOperatorAgentChannelIdentitiesRouter } from '../src/routes/operatorAgentChannelIdentities.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const calls: string[] = [];

describe('operator channel-identities router — preview draft agents', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/operator/agents',
      createOperatorAgentChannelIdentitiesRouter({
        getService: () =>
          ({
            overview: async () => {
              calls.push('overview');
              return { channels: [] };
            },
            provision: async () => {
              calls.push('provision');
              return { ok: true };
            },
            remove: async () => {
              calls.push('remove');
              return { ok: false, status: 404, error: 'identity_not_found', message: 'none' };
            },
          }) as never,
        findAgent: async (slug: string) => ({ id: `id-${slug}`, slug, displayName: slug }) as never,
        recordAudit: async () => {},
      }),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/operator/agents`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('refuses a bot for a preview draft agent before any plugin is asked', async () => {
    const res = await fetch(`${base}/builder-preview-abc/channel-identities/telegram`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: { token: 'fake-token' } }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error?: string }).error, 'preview_draft_agent');
    assert.deepEqual(calls, []);
  });

  it('still reads and removes for a preview draft agent', async () => {
    assert.equal((await fetch(`${base}/builder-preview-abc/channel-identities`)).status, 200);
    await fetch(`${base}/builder-preview-abc/channel-identities/telegram`, { method: 'DELETE' });
    assert.deepEqual(calls, ['overview', 'remove']);
  });
});
