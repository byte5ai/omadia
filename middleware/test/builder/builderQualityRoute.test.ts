import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { registerBuilderQualityRoute } from '../../src/routes/builderQuality.js';

declare module 'express-serve-static-core' {
  interface Request {
    session?: { email?: string };
  }
}

async function bootServer(
  draftStore: DraftStore,
  email: string,
): Promise<{ url: string; server: Server }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { email };
    next();
  });
  const router = express.Router();
  registerBuilderQualityRoute(router, { draftStore });
  app.use('/v1/builder', router);
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('builderQuality route (issue #52)', () => {
  let tmpRoot: string;
  let store: DraftStore;
  let server: Server;
  let baseUrl: string;
  let draftId: string;
  const userEmail = 'alice@example.com';

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'quality-route-'));
    store = new DraftStore({ dbPath: path.join(tmpRoot, 'drafts.db') });
    await store.open();
    const d = await store.create(userEmail, 'Weather');
    draftId = d.id;
    const boot = await bootServer(store, userEmail);
    server = boot.server;
    baseUrl = boot.url;
  });

  afterEach(async () => {
    await closeServer(server);
    await store.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns a QualityResult for an empty draft (score ≤ 10, sweetspot=under)', async () => {
    const res = await fetch(`${baseUrl}/v1/builder/drafts/${draftId}/quality`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      score: number;
      dimensions: { completeness: number; tokenEfficiency: number; ruleQuality: number; specificity: number };
      sweetspot: string;
      tokenHealth: string;
      suggestions: { code: string }[];
    };
    assert.ok(body.score <= 10);
    assert.equal(body.sweetspot, 'under');
    assert.equal(body.tokenHealth, 'ok');
    assert.ok(Array.isArray(body.suggestions));
    assert.ok(body.suggestions.some((s) => s.code === 'missing_field'));
  });

  it('returns 404 for an unreachable draft id', async () => {
    const res = await fetch(`${baseUrl}/v1/builder/drafts/does-not-exist/quality`);
    assert.equal(res.status, 404);
  });
});
