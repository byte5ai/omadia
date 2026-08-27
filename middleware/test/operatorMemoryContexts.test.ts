import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { InMemoryMemoryStore } from '@omadia/memory';

import {
  CONTEXTS_ROOT,
  createOperatorMemoryContextsRouter,
  resolveContextPath,
} from '../src/routes/operatorMemoryContexts.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * HTTP integration test for the operator memory-context browser
 * (`createOperatorMemoryContextsRouter`), mounted in prod at
 * `/api/v1/operator/memory/contexts` behind `requireAuth`, so the live URLs
 * are `GET /api/v1/operator/memory/contexts/{list,file}?path=…`.
 *
 * The router is driven end-to-end over an express `listen(0)` server against a
 * real `InMemoryMemoryStore` — the same `MemoryStore` contract prod runs on —
 * and the REAL `createRootedMemoryAccessor`. Nothing about the scoping is
 * faked, because the scoping IS the feature: this is an authenticated listing
 * whose only barrier to the rest of `/memories` is the path guard.
 *
 * `requireAuth` runs at MOUNT time in prod, not inside the router (same as
 * `memoryPromoteRoute.test.ts`), so the harness injects a `req.session` — or
 * omits it, to exercise the router's own 401.
 *
 * Every store is seeded with DECOYS outside the context root: an agent-tier
 * file, a shared-kernel file, and a `/memories/contextsX` sibling whose name
 * shares a prefix with the root. A guard that passes the happy path but leaks
 * one of these is worse than no endpoint, so each escape attempt asserts both
 * the status AND that the decoy's content never appears in the body.
 *
 * Pollution guard: every test builds its own store, its own server and its own
 * log buffer — no module-level fixtures, no shared state.
 */

const MOUNT = '/api/v1/operator/memory/contexts';
const SLUG = 'atlas';
const CHANNEL_KEY = 'teams~19-chan-a-aaaa1111';
const TEAM_KEY = 'teams~team-alpha-bbbb2222';

const CHANNEL_ROOT = `${CONTEXTS_ROOT}/${SLUG}/channel/${CHANNEL_KEY}`;
const TEAM_ROOT = `${CONTEXTS_ROOT}/${SLUG}/team/${TEAM_KEY}`;

const AGENT_TIER_SECRET = 'AGENT-TIER-SECRET';
const KERNEL_SECRET = 'KERNEL-SECRET';
const SIBLING_SECRET = 'SIBLING-SECRET';

interface Harness {
  list: (path?: string) => string;
  file: (path?: string) => string;
  store: InMemoryMemoryStore;
  logs: string[];
  close: () => Promise<void>;
}

/** Stand up a fresh server + store. `actor === null` omits the session
 *  entirely so the router's own 401 guard fires. `seed: false` leaves the
 *  store completely empty. */
async function makeHarness(
  options: { actor?: string | null; seed?: boolean } = {},
): Promise<Harness> {
  const store = new InMemoryMemoryStore();
  if (options.seed !== false) {
    await store.createFile(`${CHANNEL_ROOT}/notes/deploy.md`, '# Deploy\n\nrun-it\n');
    await store.createFile(`${TEAM_ROOT}/runbook.md`, 'team runbook\n');
    // Decoys the guard must never reach.
    await store.createFile(
      `/memories/orchestrators/${SLUG}/private.md`,
      AGENT_TIER_SECRET,
    );
    await store.createFile('/memories/core/kernel.md', KERNEL_SECRET);
    await store.createFile('/memories/contextsX/leak.md', SIBLING_SECRET);
  }

  const logs: string[] = [];
  const actor = options.actor === undefined ? 'operator-user-1' : options.actor;

  const app = express();
  if (actor !== null) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { session: Record<string, string> }).session = {
        omadia_user_id: actor,
      };
      next();
    });
  }
  app.use(
    MOUNT,
    createOperatorMemoryContextsRouter({
      store,
      log: (message) => logs.push(message),
    }),
  );

  const server: Server = await listenLoopback(app);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}${MOUNT}`;

  const withPath = (verb: string, path?: string): string =>
    path === undefined
      ? `${base}/${verb}`
      : `${base}/${verb}?path=${encodeURIComponent(path)}`;

  return {
    list: (path) => withPath('list', path),
    file: (path) => withPath('file', path),
    store,
    logs,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface ListEntry {
  virtualPath: string;
  isDirectory: boolean;
  sizeBytes: number;
}

interface ListBody {
  path: string;
  entries: ListEntry[];
}

async function listBody(res: { json: () => Promise<unknown> }): Promise<ListBody> {
  return (await res.json()) as ListBody;
}

async function errorOf(res: { json: () => Promise<unknown> }): Promise<string> {
  const body = (await res.json()) as { error?: unknown };
  return typeof body.error === 'string' ? body.error : '';
}

describe('operator memory-contexts listing', () => {
  it('lists the context root with the dev-router wire shape', async () => {
    const h = await makeHarness();
    try {
      const res = await fetch(h.list(CONTEXTS_ROOT));
      assert.equal(res.status, 200);
      const body = await listBody(res);

      assert.equal(body.path, CONTEXTS_ROOT);
      // Same three fields the dev router emits, so `web-ui`'s existing
      // ListResponse/Entry types carry over with only the URL changed.
      for (const entry of body.entries) {
        assert.deepEqual(Object.keys(entry).sort(), [
          'isDirectory',
          'sizeBytes',
          'virtualPath',
        ]);
        assert.equal(typeof entry.isDirectory, 'boolean');
        assert.equal(typeof entry.sizeBytes, 'number');
      }
      const paths = body.entries.map((e) => e.virtualPath);
      assert.ok(paths.includes(`${CONTEXTS_ROOT}/${SLUG}`), paths.join(', '));
    } finally {
      await h.close();
    }
  });

  it('never emits an entry outside the context root', async () => {
    const h = await makeHarness();
    try {
      for (const path of [
        CONTEXTS_ROOT,
        `${CONTEXTS_ROOT}/${SLUG}`,
        `${CONTEXTS_ROOT}/${SLUG}/channel`,
        CHANNEL_ROOT,
      ]) {
        const res = await fetch(h.list(path));
        assert.equal(res.status, 200, path);
        const body = await listBody(res);
        for (const entry of body.entries) {
          assert.ok(
            entry.virtualPath === CONTEXTS_ROOT ||
              entry.virtualPath.startsWith(`${CONTEXTS_ROOT}/`),
            `entry escaped the root: ${entry.virtualPath}`,
          );
        }
      }
    } finally {
      await h.close();
    }
  });

  it('lists a concrete context tier', async () => {
    const h = await makeHarness();
    try {
      const res = await fetch(h.list(CHANNEL_ROOT));
      assert.equal(res.status, 200);
      const body = await listBody(res);
      const paths = body.entries.map((e) => e.virtualPath);
      assert.ok(paths.includes(`${CHANNEL_ROOT}/notes`), paths.join(', '));
      assert.ok(
        paths.includes(`${CHANNEL_ROOT}/notes/deploy.md`),
        paths.join(', '),
      );
    } finally {
      await h.close();
    }
  });

  it('treats a missing context root as an empty listing, not a 404', async () => {
    // A store that has never written a context tree genuinely has no
    // /memories/contexts directory. That is an empty browser, not a failure —
    // an operator must not read "unreachable" as "no context trees exist".
    const h = await makeHarness({ seed: false });
    try {
      const res = await fetch(h.list(CONTEXTS_ROOT));
      assert.equal(res.status, 200);
      const body = await listBody(res);
      assert.deepEqual(body.entries, []);
    } finally {
      await h.close();
    }
  });

  it('404s an unknown path INSIDE the root', async () => {
    const h = await makeHarness();
    try {
      const res = await fetch(h.list(`${CONTEXTS_ROOT}/${SLUG}/channel/nope`));
      assert.equal(res.status, 404);
      assert.equal(await errorOf(res), 'not_found');
    } finally {
      await h.close();
    }
  });
});

describe('operator memory-contexts scope guard', () => {
  const escapes: ReadonlyArray<{ label: string; path: string; leak: string }> = [
    {
      label: 'a traversal out of the root',
      path: `${CONTEXTS_ROOT}/../orchestrators/${SLUG}/private.md`,
      leak: AGENT_TIER_SECRET,
    },
    {
      label: 'a traversal buried mid-path',
      path: `${CONTEXTS_ROOT}/${SLUG}/../../core/kernel.md`,
      leak: KERNEL_SECRET,
    },
    {
      label: 'a sibling that merely shares the root prefix',
      path: '/memories/contextsX/leak.md',
      leak: SIBLING_SECRET,
    },
    {
      label: 'a sibling tree of the root',
      path: `/memories/orchestrators/${SLUG}`,
      leak: AGENT_TIER_SECRET,
    },
    {
      label: 'the whole memory root',
      path: '/memories',
      leak: KERNEL_SECRET,
    },
  ];

  for (const { label, path, leak } of escapes) {
    it(`rejects ${label} on /list`, async () => {
      const h = await makeHarness();
      try {
        const res = await fetch(h.list(path));
        assert.equal(res.status, 400, `${path} was not rejected`);
        const text = await res.text();
        assert.ok(!text.includes(leak), `leaked out-of-scope content: ${text}`);
        const parsed = JSON.parse(text) as { error?: unknown };
        assert.equal(parsed.error, 'invalid_path');
      } finally {
        await h.close();
      }
    });

    it(`rejects ${label} on /file`, async () => {
      const h = await makeHarness();
      try {
        const res = await fetch(h.file(path));
        assert.equal(res.status, 400, `${path} was not rejected`);
        const text = await res.text();
        assert.ok(!text.includes(leak), `leaked out-of-scope content: ${text}`);
      } finally {
        await h.close();
      }
    });
  }

  it('rejects a relative path, a NUL byte and an over-long path', async () => {
    const h = await makeHarness();
    try {
      for (const path of [
        `${SLUG}/channel`,
        `${CONTEXTS_ROOT}/${SLUG}\u0000.md`,
        `${CONTEXTS_ROOT}/${'a'.repeat(1100)}`,
      ]) {
        const res = await fetch(h.list(path));
        assert.equal(res.status, 400, `${path.slice(0, 40)} was not rejected`);
      }
    } finally {
      await h.close();
    }
  });

  it('is a pure function that normalises rather than guesses', () => {
    assert.deepEqual(resolveContextPath(undefined), {
      abs: CONTEXTS_ROOT,
      rel: '',
    });
    assert.deepEqual(resolveContextPath(''), { abs: CONTEXTS_ROOT, rel: '' });
    // Redundant and trailing slashes normalise away; they are not an attack,
    // and the store must never see the raw form either way.
    assert.deepEqual(resolveContextPath(`${CONTEXTS_ROOT}//a///b/`), {
      abs: `${CONTEXTS_ROOT}/a/b`,
      rel: 'a/b',
    });
    // A repeated array `?path=a&path=b` arrives as a non-string.
    assert.equal(resolveContextPath(['a', 'b']), null);
    assert.equal(resolveContextPath('/memories/context'), null);
    assert.equal(resolveContextPath('/memories/contexts/..'), null);
    assert.equal(resolveContextPath('/memories/contexts/./a'), null);
  });
});

describe('operator memory-contexts auth + read-only surface', () => {
  it('401s without a session on both verbs', async () => {
    const h = await makeHarness({ actor: null });
    try {
      for (const url of [h.list(CONTEXTS_ROOT), h.file(`${TEAM_ROOT}/runbook.md`)]) {
        const res = await fetch(url);
        assert.equal(res.status, 401);
        assert.equal(await errorOf(res), 'auth.required');
      }
    } finally {
      await h.close();
    }
  });

  it('does not answer the 401 with any memory content', async () => {
    const h = await makeHarness({ actor: null });
    try {
      const res = await fetch(h.file(`${TEAM_ROOT}/runbook.md`));
      const text = await res.text();
      assert.ok(!text.includes('team runbook'));
    } finally {
      await h.close();
    }
  });

  it('exposes no write verb', async () => {
    // Read-only by construction: promotion is the ONE audited way knowledge
    // crosses a context boundary, and it lives on its own router.
    const h = await makeHarness();
    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(h.list(CHANNEL_ROOT), { method });
        assert.equal(res.status, 404, `${method} was routed`);
      }
      // The tree is untouched.
      assert.equal(
        await h.store.fileExists(`${CHANNEL_ROOT}/notes/deploy.md`),
        true,
      );
    } finally {
      await h.close();
    }
  });
});

describe('operator memory-contexts file preview', () => {
  it('serves a file as text/plain', async () => {
    const h = await makeHarness();
    try {
      const res = await fetch(h.file(`${CHANNEL_ROOT}/notes/deploy.md`));
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
      assert.equal(await res.text(), '# Deploy\n\nrun-it\n');
    } finally {
      await h.close();
    }
  });

  it('404s a missing file inside the root', async () => {
    const h = await makeHarness();
    try {
      const res = await fetch(h.file(`${CHANNEL_ROOT}/notes/ghost.md`));
      assert.equal(res.status, 404);
      assert.equal(await errorOf(res), 'not_found');
    } finally {
      await h.close();
    }
  });

  it('400s a request for the root itself', async () => {
    const h = await makeHarness();
    try {
      const res = await fetch(h.file(CONTEXTS_ROOT));
      assert.equal(res.status, 400);
      assert.equal(await errorOf(res), 'invalid_path');
    } finally {
      await h.close();
    }
  });

  it('400s a directory read without claiming it is missing', async () => {
    const h = await makeHarness();
    try {
      const res = await fetch(h.file(CHANNEL_ROOT));
      assert.equal(res.status, 400);
      assert.equal(await errorOf(res), 'memory_read_failed');
    } finally {
      await h.close();
    }
  });
});
