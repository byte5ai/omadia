/**
 * #1456 — the ZIP-upload route must forward the CLASSIFIED reason, not only
 * the plugin API's sentence.
 *
 * `PackageUploadService.ingest` computes the reason, and the upload row in the
 * store reads `activation_error_reason`. While the route dropped the field the
 * row always fell back to the generic "start-up failed" copy — the reason
 * existed, was recorded, and never left the process.
 *
 * A fake upload service is the right seam here: the route's whole job for this
 * field is to pass it on, and driving a real failed re-activation through a
 * multipart upload would test the upload pipeline instead.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { createPackagesRouter } from '../src/routes/packages.js';
import type {
  IngestResult,
  PackageUploadService,
} from '../src/plugins/packageUploadService.js';
import type { UploadedPackage, UploadedPackageStore } from '../src/plugins/uploadedPackageStore.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';

const PACKAGE: UploadedPackage = {
  id: 'pkg_1',
  plugin_id: '@omadia/integration-odoo',
  version: '0.2.0',
  uploaded_at: '2026-10-28T00:00:00.000Z',
  uploaded_by: 'test@example.com',
  sha256: '0'.repeat(64),
  peers_missing: [],
  zip_bytes: 1,
  extracted_bytes: 1,
  file_count: 1,
} as unknown as UploadedPackage;

const SENTENCE =
  "plugin '@omadia/integration-odoo' called ctx.services.get('entityRefBus') but its manifest does not declare that capability";

function emptyCatalog(): PluginCatalog {
  return { get: () => undefined, list: () => [] } as unknown as PluginCatalog;
}

function fakeStore(): UploadedPackageStore {
  return {
    get: () => undefined,
    list: () => [],
    add: async () => {},
    remove: async () => true,
  } as unknown as UploadedPackageStore;
}

async function upload(result: IngestResult): Promise<Record<string, unknown>> {
  const app = express();
  app.use(
    '/packages',
    createPackagesRouter({
      service: { ingest: async () => result } as unknown as PackageUploadService,
      store: fakeStore(),
      registry: new InMemoryInstalledRegistry(),
      catalog: emptyCatalog(),
      maxBytes: 1024 * 1024,
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }),
      'plugin.zip',
    );
    const res = await fetch(`http://127.0.0.1:${String(port)}/packages/upload`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 201);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    server.close();
  }
}

void describe('POST /packages/upload — activation failure (#1456)', () => {
  void it('forwards the classified reason next to the sentence', async () => {
    const body = await upload({
      ok: true,
      package: PACKAGE,
      plugin_id: PACKAGE.plugin_id,
      version: PACKAGE.version,
      activation_error: SENTENCE,
      activation_error_reason: {
        code: 'capability_not_declared',
        capability: 'entityRefBus',
      },
    } as unknown as IngestResult);

    assert.equal(body['activation_error'], SENTENCE);
    assert.deepEqual(body['activation_error_reason'], {
      code: 'capability_not_declared',
      capability: 'entityRefBus',
    });
  });

  void it('omits both fields when the plugin came back up', async () => {
    const body = await upload({
      ok: true,
      package: PACKAGE,
      plugin_id: PACKAGE.plugin_id,
      version: PACKAGE.version,
    } as unknown as IngestResult);

    assert.equal('activation_error' in body, false);
    assert.equal('activation_error_reason' in body, false);
  });
});
