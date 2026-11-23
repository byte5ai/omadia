/**
 * #2049 × spec 2042 §5.4 — the draft agent of a Plugin Builder preview is
 * never configured through the consultation API: neither its switches nor a
 * grant from or to it. Reading stays allowed.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { createOperatorConsultationRouter } from '../../src/routes/operatorConsultation.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

const writes: string[] = [];

function agent(slug: string) {
  return { id: `id-${slug}`, slug, archetype: null } as never;
}

describe('operator consultation router — preview draft agents', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/operator',
      createOperatorConsultationRouter({
        getConfigStore: () => ({
          getAgentBySlug: async (slug: string) => agent(slug),
          getAgentById: async (id: string) => agent(id.replace(/^id-/, '')),
        }) as never,
        consultationStore: {
          getSwitches: async () => undefined,
          setSwitches: async (_id: string, body: object) => {
            writes.push('switches');
            return { consultable: false, mayConsult: false, ...body };
          },
          listGrantsOf: async () => [],
          upsertGrant: async () => {
            writes.push('grant');
            throw new Error('not reached');
          },
          deleteGrant: async () => false,
        } as never,
        discretionStore: {} as never,
        refreshBroker: async () => {},
      }),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/operator`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function put(path: string, body: object): Promise<{ status: number; error?: string }> {
    const res = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: string };
    return { status: res.status, error: json.error };
  }

  it('refuses switching consultation on for a preview draft agent', async () => {
    const res = await put('/agents/builder-preview-abc/consultation', { consultable: true });
    assert.deepEqual(res, { status: 409, error: 'preview_draft_agent' });
  });

  it('refuses a grant from or to a preview draft agent', async () => {
    assert.equal((await put('/agents/builder-preview-abc/consultation/grants/sales', {})).status, 409);
    const to = await put('/agents/sales/consultation/grants/builder-preview-abc', {});
    assert.deepEqual(to, { status: 409, error: 'preview_draft_agent' });
    assert.deepEqual(writes, []);
  });

  it('still reads a preview draft agent and configures ordinary agents', async () => {
    const read = await fetch(`${base}/agents/builder-preview-abc/consultation`);
    assert.equal(read.status, 200);
    const ok = await put('/agents/sales/consultation', { mayConsult: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(writes, ['switches']);
  });
});
