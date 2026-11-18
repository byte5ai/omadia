import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';

import type { InstallChainResolution } from '../src/plugins/capabilityResolver.js';
import { InstallError, type InstallService } from '../src/plugins/installService.js';
import { createInstallRouter } from '../src/routes/install.js';

/** #1463 — the 409 `install.missing_capability` carries Hub candidates. */
const MISSING: InstallChainResolution = {
  unresolved_requires: ['odoo.client@^1'],
  available_providers: [{ capability: 'odoo.client@^1', providers: [] }],
};

async function post(
  enrich?: (chain: InstallChainResolution) => Promise<InstallChainResolution>,
): Promise<{ status: number; body: { code: string; details?: InstallChainResolution } }> {
  const service = {
    create: () => {
      throw new InstallError('install.missing_capability', 'missing', 409, MISSING);
    },
  } as unknown as InstallService;
  const app = express();
  app.use(
    '/install',
    createInstallRouter({ service, ...(enrich ? { enrichMissingCapability: enrich } : {}) }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${String(port)}/install/plugins/x`, {
      method: 'POST',
    });
    return { status: res.status, body: (await res.json()) as never };
  } finally {
    server.close();
  }
}

describe('#1463 — POST /install/plugins/:id enriches a missing capability', () => {
  it('sends the chain unchanged without an enricher', async () => {
    const { status, body } = await post();
    assert.equal(status, 409);
    assert.deepEqual(body.details, MISSING);
  });

  it('sends the enriched chain, and the original one when enrichment fails', async () => {
    const enriched = await post(async (chain) => ({
      ...chain,
      available_providers: [
        {
          capability: 'odoo.client@^1',
          providers: [
            {
              id: '@omadia/integration-odoo',
              name: 'Odoo Connector',
              kind: 'integration',
              version: '0.2.1',
              install_state: 'update-available',
              already_installed: true,
              active: false,
              source: 'registry',
              update_from: '0.2.0',
            },
          ],
        },
      ],
    }));
    assert.equal(enriched.status, 409);
    assert.equal(enriched.body.code, 'install.missing_capability');
    assert.equal(enriched.body.details?.available_providers[0]?.providers[0]?.update_from, '0.2.0');

    const failed = await post(() => Promise.reject(new Error('hub down')));
    assert.equal(failed.status, 409);
    assert.deepEqual(failed.body.details, MISSING);
  });
});
