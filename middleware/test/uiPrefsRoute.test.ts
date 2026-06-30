import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';
import type { Request, Response, NextFunction } from 'express';

import { InMemoryMemoryStore } from '@omadia/memory';

import { createUiPrefsRouter } from '../src/routes/uiPrefs.js';

/**
 * HTTP integration test for the per-user UI-prefs router (issue #287),
 * mounted in prod at `/api/v1/ui-prefs` behind `requireAuth`. Drives the REAL
 * router end-to-end over an express `listen(0)` server with a real
 * `InMemoryMemoryStore` (same MemoryStore contract as prod). `requireAuth`
 * runs at MOUNT time in prod, not inside the router, so the harness injects a
 * `req.session` with the user id the router reads (or omits it to exercise the
 * router's own 401 guard).
 */

const MOUNT = '/api/v1/ui-prefs';

interface Harness {
  baseUrl: string;
  store: InMemoryMemoryStore;
  close: () => Promise<void>;
}

async function makeHarness(
  userId: string | null,
  sharedStore?: InMemoryMemoryStore,
): Promise<Harness> {
  const store = sharedStore ?? new InMemoryMemoryStore();

  const app = express();
  app.use(express.json());
  if (userId) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { session: { omadia_user_id: string } }).session = {
        omadia_user_id: userId,
      };
      next();
    });
  }
  app.use(MOUNT, createUiPrefsRouter({ store, log: () => {} }));

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}${MOUNT}`,
    store,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function req(
  url: string,
  method: 'GET' | 'PUT',
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

describe('ui-prefs router', () => {
  it('returns {} when the user has no stored prefs', async () => {
    const h = await makeHarness('user-1');
    try {
      const res = await req(h.baseUrl, 'GET');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {});
    } finally {
      await h.close();
    }
  });

  it('round-trips a PUT then GET, scoped per user', async () => {
    const h = await makeHarness('user-1');
    try {
      const put = await req(h.baseUrl, 'PUT', {
        palette: 'petrol',
        appearance: 'dark',
      });
      assert.equal(put.status, 204);

      const get = await req(h.baseUrl, 'GET');
      assert.equal(get.status, 200);
      assert.deepEqual(get.body, { palette: 'petrol', appearance: 'dark' });

      // Stored under the collapsed default/operator scope for this user.
      const raw = await h.store.readFile(
        '/memories/ui-prefs/default/user-1/operator.json',
      );
      assert.deepEqual(JSON.parse(raw), { palette: 'petrol', appearance: 'dark' });
    } finally {
      await h.close();
    }
  });

  it('accepts a partial PUT (palette only)', async () => {
    const h = await makeHarness('user-1');
    try {
      const put = await req(h.baseUrl, 'PUT', { palette: 'atelier' });
      assert.equal(put.status, 204);
      const get = await req(h.baseUrl, 'GET');
      assert.deepEqual(get.body, { palette: 'atelier' });
    } finally {
      await h.close();
    }
  });

  it('merges a partial PUT into the stored prefs (does not drop the other key)', async () => {
    const h = await makeHarness('user-1');
    try {
      let put = await req(h.baseUrl, 'PUT', {
        palette: 'petrol',
        appearance: 'dark',
      });
      assert.equal(put.status, 204);

      // A palette-only PUT must leave the stored appearance intact.
      put = await req(h.baseUrl, 'PUT', { palette: 'atelier' });
      assert.equal(put.status, 204);

      const get = await req(h.baseUrl, 'GET');
      assert.deepEqual(get.body, { palette: 'atelier', appearance: 'dark' });
    } finally {
      await h.close();
    }
  });

  it('isolates collision-prone ids on a shared store', async () => {
    // `safeSegment` must escape injectively: "a b" and "a_b" are distinct ids
    // that must not collapse onto the same storage path. Both users share ONE
    // store so a path collision would actually surface as cross-user reads.
    const store = new InMemoryMemoryStore();
    const a = await makeHarness('a b', store);
    const b = await makeHarness('a_b', store);
    try {
      assert.equal((await req(a.baseUrl, 'PUT', { palette: 'petrol' })).status, 204);
      assert.equal((await req(b.baseUrl, 'PUT', { palette: 'atelier' })).status, 204);
      assert.deepEqual((await req(a.baseUrl, 'GET')).body, { palette: 'petrol' });
      assert.deepEqual((await req(b.baseUrl, 'GET')).body, { palette: 'atelier' });
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('rejects an invalid palette or unknown key with 400', async () => {
    const h = await makeHarness('user-1');
    try {
      const bad = await req(h.baseUrl, 'PUT', { palette: 'neon' });
      assert.equal(bad.status, 400);
      assert.equal(bad.body['code'], 'ui_prefs.invalid_request');

      const extra = await req(h.baseUrl, 'PUT', { palette: 'lagoon', x: 1 });
      assert.equal(extra.status, 400);
    } finally {
      await h.close();
    }
  });

  it("contains a '..' user id inside the per-user dir (no traversal)", async () => {
    const store = new InMemoryMemoryStore();
    const h = await makeHarness('..', store);
    try {
      assert.equal((await req(h.baseUrl, 'PUT', { palette: 'petrol' })).status, 204);
      // The '..' must be escaped, NOT left as a real parent-dir segment that
      // would land the file at /memories/ui-prefs/operator.json.
      assert.equal(
        await store.fileExists('/memories/ui-prefs/operator.json'),
        false,
      );
      assert.deepEqual((await req(h.baseUrl, 'GET')).body, { palette: 'petrol' });
    } finally {
      await h.close();
    }
  });

  it('recovers from a corrupt stored value: PUT overwrites, not 500s', async () => {
    const store = new InMemoryMemoryStore();
    const h = await makeHarness('user-1', store);
    try {
      // Simulate a hand-edited / partially-written file at the user's path.
      await store.writeFile(
        '/memories/ui-prefs/default/user-1/operator.json',
        '{ this is not json',
      );
      // GET treats corrupt as unset rather than erroring.
      const get = await req(h.baseUrl, 'GET');
      assert.equal(get.status, 200);
      assert.deepEqual(get.body, {});
      // The read-merge PUT must still succeed (corrupt value can't brick writes).
      const put = await req(h.baseUrl, 'PUT', { palette: 'lagoon' });
      assert.equal(put.status, 204);
      assert.deepEqual((await req(h.baseUrl, 'GET')).body, { palette: 'lagoon' });
    } finally {
      await h.close();
    }
  });

  it('401s when there is no session', async () => {
    const h = await makeHarness(null);
    try {
      const res = await req(h.baseUrl, 'GET');
      assert.equal(res.status, 401);
      assert.equal(res.body['code'], 'auth.required');
    } finally {
      await h.close();
    }
  });
});
