import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { createProfilesRouter } from '../src/routes/profiles.js';

/**
 * PUT /:id/agent-md and PUT /:id/knowledge/:filename read the raw body
 * whatever the Content-Type — also none at all, and also an empty body.
 * `express.raw({ type: '*\/*' })` skipped requests without the header, so
 * those uploads failed with `profile_storage.invalid_body`.
 */

const emptyCatalog = {
  list: () => [],
  get: () => undefined,
  getMany: () => [],
} as unknown as PluginCatalog;

interface Written {
  readonly kind: 'agent-md' | 'knowledge';
  readonly content: Buffer;
}

function fakeLiveStorage(written: Written[]): unknown {
  const record = (content: Buffer) => ({
    sha256: 'sha',
    sizeBytes: content.byteLength,
    updatedAt: new Date(0),
  });
  return {
    async setAgentMd(_id: string, content: Buffer) {
      written.push({ kind: 'agent-md', content });
      return record(content);
    },
    async setKnowledgeFile(_id: string, _filename: string, content: Buffer) {
      written.push({ kind: 'knowledge', content });
      return { filename: 'notes.md', ...record(content) };
    },
  };
}

describe('profile raw uploads without a Content-Type', () => {
  const written: Written[] = [];
  let server: Server;
  let baseUrl: string;
  let tmpDir: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'profiles-raw-'));
    const router = createProfilesRouter({
      catalog: emptyCatalog,
      registry: new InMemoryInstalledRegistry(),
      profilesDir: tmpDir,
      liveStorage: fakeLiveStorage(written) as never,
    });
    const app = express();
    app.use((req, _res, next) => {
      (req as { session?: { email?: string } }).session = { email: 'op@example.com' };
      next();
    });
    app.use(express.json());
    app.use('/api/v1/profiles', router);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/profiles`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const cases = [
    { name: 'agent.md', path: '/demo/agent-md', kind: 'agent-md' },
    { name: 'a knowledge file', path: '/demo/knowledge/notes.md', kind: 'knowledge' },
  ] as const;

  for (const c of cases) {
    it(`stores ${c.name} sent without a Content-Type`, async () => {
      written.length = 0;
      // A Uint8Array body makes fetch send no Content-Type header.
      const res = await fetch(`${baseUrl}${c.path}`, {
        method: 'PUT',
        body: new TextEncoder().encode('# hi'),
      });
      assert.equal(res.status, 200, await res.text());
      assert.equal(written.length, 1);
      assert.equal(written[0]!.kind, c.kind);
      assert.equal(written[0]!.content.toString('utf8'), '# hi');
    });

    it(`stores an empty ${c.name} sent without a body or Content-Type`, async () => {
      written.length = 0;
      const res = await fetch(`${baseUrl}${c.path}`, { method: 'PUT' });
      assert.equal(res.status, 200, await res.text());
      assert.equal(written.length, 1);
      assert.equal(written[0]!.content.byteLength, 0);
    });
  }
});
