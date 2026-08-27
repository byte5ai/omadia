import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { InMemoryMemoryStore } from '@omadia/memory';
import type { MemoryStore } from '@omadia/plugin-api';

import { PROMOTION_AUDIT_PATH } from '../src/services/memoryPromote.js';
import { createMemoryPromoteRouter } from '../src/routes/memoryPromote.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * HTTP integration test for the memory-promotion router
 * (`createMemoryPromoteRouter`), mounted in prod at
 * `/api/v1/admin/memory/promotions` behind `requireAuth` so the live URLs are
 * `POST|GET /api/v1/admin/memory/promotions/:slug`.
 *
 * That prefix and that gate are deliberately the SAME as the Danger-Zone purge
 * router's (`/api/v1/admin/memory/purge`, cookie session JWT — NOT the
 * machine-to-machine ADMIN_TOKEN surface). Promotion is the one way knowledge
 * crosses a chat-context boundary, so it is an operator judgement call that has
 * to be attributable to a person; the audit line records that person as its
 * actor. The design spec's `/api/agents/:slug/memory/promotions` would have
 * introduced a third auth surface for a Danger-Zone-class action.
 *
 * Drives the REAL router end-to-end over an express `listen(0)` server with a
 * real `InMemoryMemoryStore` (same MemoryStore contract as prod) and the REAL
 * `promoteMemory` service — nothing about the promotion is faked.
 *
 * `requireAuth` runs at MOUNT time in prod, not inside the router (same as
 * `memoryPurgeRoute.test.ts`), so the harness injects a `req.session` — or
 * omits it, to exercise the router's own 401 and the fact that the audited
 * `actor` comes from that session and never from the request body.
 *
 * Pollution guard (design spec §8): every test builds its own store, its own
 * server and its own log buffer — no module-level fixtures, no shared state.
 */

const MOUNT = '/api/v1/admin/memory/promotions';
const SLUG = 'atlas';
const OTHER_SLUG = 'borea';
const ACTOR = 'operator-user-1';

const CHANNEL_KEY = 'teams~19-chan-a-aaaa1111';
const TEAM_KEY = 'teams~team-alpha-bbbb2222';

const CHANNEL_ROOT = `/memories/contexts/${SLUG}/channel/${CHANNEL_KEY}`;
const TEAM_ROOT = `/memories/contexts/${SLUG}/team/${TEAM_KEY}`;
const AGENT_ROOT = `/memories/orchestrators/${SLUG}`;

interface Harness {
  url: (slug?: string) => string;
  store: InMemoryMemoryStore;
  logs: string[];
  close: () => Promise<void>;
}

function copyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'notes/deploy.md' },
    target: { tier: 'team', ctxKey: TEAM_KEY },
    mode: 'copy',
    reason: 'team-wide runbook',
    ...overrides,
  };
}

/** Stand up a fresh server + a freshly-seeded store. `actor === null` omits
 *  the session entirely so the router's own 401 guard fires. */
async function makeHarness(options: {
  actor?: string | null;
  /** Wrap the store so writing the audit JSONL fails — proves an audit gap
   *  never masks a promotion that already landed. */
  breakAuditWrite?: boolean;
} = {}): Promise<Harness> {
  const store = new InMemoryMemoryStore();
  await store.createFile(`${CHANNEL_ROOT}/notes/deploy.md`, '# Deploy\n\nrun-it\n');

  const logs: string[] = [];
  const actor = options.actor === undefined ? ACTOR : options.actor;

  const app = express();
  app.use(express.json());
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
    createMemoryPromoteRouter({
      store: options.breakAuditWrite ? withBrokenAuditWrite(store) : store,
      log: (message) => logs.push(message),
    }),
  );

  const server: Server = await listenLoopback(app);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}${MOUNT}`;

  return {
    url: (slug = SLUG) => `${base}/${slug}`,
    store,
    logs,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Delegating MemoryStore whose only difference is that the audit-line write
 *  throws. The promotion's own writes still land, which is the point. */
function withBrokenAuditWrite(store: InMemoryMemoryStore): MemoryStore {
  const proxied = Object.create(store) as MemoryStore;
  proxied.writeFile = async (path: string, content: string): Promise<void> => {
    if (path === PROMOTION_AUDIT_PATH) throw new Error('disk on fire');
    await store.writeFile(path, content);
  };
  return proxied;
}

async function send(
  url: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
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

function receiptOf(body: Record<string, unknown>): Record<string, unknown> {
  const receipt = body['receipt'];
  assert.ok(receipt && typeof receipt === 'object', `no receipt in ${JSON.stringify(body)}`);
  return receipt as Record<string, unknown>;
}

async function auditLines(
  store: InMemoryMemoryStore,
): Promise<Array<Record<string, unknown>>> {
  const raw = await store.readFile(PROMOTION_AUDIT_PATH);
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('memory-promote router (HTTP, end-to-end)', () => {
  it('1. POST without a session → 401, nothing promoted', async () => {
    const h = await makeHarness({ actor: null });
    try {
      const res = await send(h.url(), 'POST', copyBody());
      assert.equal(res.status, 401);
      assert.equal(res.body['error'], 'auth.required');
      assert.equal(await h.store.fileExists(`${TEAM_ROOT}/notes/deploy.md`), false);
    } finally {
      await h.close();
    }
  });

  it('2. GET without a session → 401', async () => {
    const h = await makeHarness({ actor: null });
    try {
      const res = await send(h.url(), 'GET');
      assert.equal(res.status, 401);
      assert.equal(res.body['error'], 'auth.required');
    } finally {
      await h.close();
    }
  });

  it('3. POST copy → 200 receipt, provenance in the target, audit line written', async () => {
    const h = await makeHarness();
    try {
      const res = await send(h.url(), 'POST', copyBody());
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const receipt = receiptOf(res.body);
      assert.equal(receipt['agentSlug'], SLUG);
      assert.equal(receipt['actor'], ACTOR);
      assert.equal(receipt['mode'], 'copy');
      assert.equal(receipt['sourcePath'], `${CHANNEL_ROOT}/notes/deploy.md`);
      assert.equal(receipt['targetPath'], `${TEAM_ROOT}/notes/deploy.md`);
      assert.equal(receipt['auditPath'], PROMOTION_AUDIT_PATH);

      // Copy leaves the source in place and stamps provenance on the target.
      assert.equal(await h.store.fileExists(`${CHANNEL_ROOT}/notes/deploy.md`), true);
      const written = await h.store.readFile(`${TEAM_ROOT}/notes/deploy.md`);
      assert.match(written, /^---\n/);
      assert.match(written, /promoted-by: "operator-user-1"/);
      assert.match(written, /run-it/);

      const lines = await auditLines(h.store);
      assert.equal(lines.length, 1);
      assert.equal(lines[0]?.['actor'], ACTOR);
      assert.equal(lines[0]?.['agentSlug'], SLUG);
      assert.equal(lines[0]?.['reason'], 'team-wide runbook');
    } finally {
      await h.close();
    }
  });

  it('4. the audited actor comes from the session — a body `actor` is ignored', async () => {
    const h = await makeHarness();
    try {
      const res = await send(
        h.url(),
        'POST',
        copyBody({ actor: 'mallory', agentSlug: 'someone-else' }),
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(receiptOf(res.body)['actor'], ACTOR);
      assert.equal(receiptOf(res.body)['agentSlug'], SLUG);
    } finally {
      await h.close();
    }
  });

  it('5. POST with an unknown mode → 400 invalid_request carrying zod issues', async () => {
    const h = await makeHarness();
    try {
      const res = await send(h.url(), 'POST', copyBody({ mode: 'teleport' }));
      assert.equal(res.status, 400);
      assert.equal(res.body['error'], 'invalid_request');
      assert.ok(Array.isArray(res.body['issues']));
      assert.ok((res.body['issues'] as unknown[]).length > 0);
    } finally {
      await h.close();
    }
  });

  it('6. POST with a traversal source path → 400 invalid_path, nothing written', async () => {
    const h = await makeHarness();
    try {
      const res = await send(
        h.url(),
        'POST',
        copyBody({ source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: '../../escape.md' } }),
      );
      assert.equal(res.status, 400);
      assert.equal(res.body['error'], 'invalid_path');
      assert.equal(await h.store.fileExists(PROMOTION_AUDIT_PATH), false);
    } finally {
      await h.close();
    }
  });

  it('7. POST for a missing source → 404 source_not_found, and NOT flagged partial', async () => {
    const h = await makeHarness();
    try {
      const res = await send(
        h.url(),
        'POST',
        copyBody({ source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'nope.md' } }),
      );
      assert.equal(res.status, 404);
      assert.equal(res.body['error'], 'source_not_found');
      // A pre-write validation rejection genuinely means both tiers are
      // untouched, so it must NOT tell the operator to go inspect the target.
      assert.equal(res.body['partial'], undefined);
    } finally {
      await h.close();
    }
  });

  it('7b. a store failure mid-write is reported as PARTIAL, not as "nothing happened"', async () => {
    // `promoteMemory` writes the planned files in an unguarded loop with no
    // rollback. A store failure part-way leaves the promotion half applied —
    // but such an error carries no `code`, so it used to be indistinguishable
    // from a clean rejection. The operator would retry, hit 409 target_exists
    // on the files that DID land, and be told there is a conflict on a
    // promotion the API twice reported as never having started.
    const h = await makeHarness();
    try {
      await h.store.createFile(`${CHANNEL_ROOT}/runbooks/one.md`, 'first\n');
      await h.store.createFile(`${CHANNEL_ROOT}/runbooks/two.md`, 'second\n');

      // Fail the SECOND payload write; the audit write is a different path.
      let payloadWrites = 0;
      const original = h.store.writeFile.bind(h.store);
      h.store.writeFile = async (path: string, content: string): Promise<void> => {
        if (path !== PROMOTION_AUDIT_PATH) {
          payloadWrites += 1;
          if (payloadWrites === 2) throw new Error('quota exceeded');
        }
        await original(path, content);
      };

      const res = await send(
        h.url(),
        'POST',
        copyBody({
          source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'runbooks' },
          target: { tier: 'agent', path: 'runbooks' },
        }),
      );

      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body['error'], 'memory_promote_failed');
      assert.equal(res.body['partial'], true, 'the ambiguity must be surfaced');
      assert.match(String(res.body['warning']), /partially applied/);

      // And the state really is half-applied — the flag is not decoration.
      assert.equal(await h.store.fileExists(`${AGENT_ROOT}/runbooks/one.md`), true);
      assert.equal(await h.store.fileExists(`${AGENT_ROOT}/runbooks/two.md`), false);
    } finally {
      await h.close();
    }
  });

  it('8. POST onto an existing target → 409, and 200 with overwrite:true', async () => {
    const h = await makeHarness();
    try {
      await h.store.createFile(`${TEAM_ROOT}/notes/deploy.md`, 'older knowledge\n');

      const conflict = await send(h.url(), 'POST', copyBody());
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body['error'], 'target_exists');
      assert.equal(
        await h.store.readFile(`${TEAM_ROOT}/notes/deploy.md`),
        'older knowledge\n',
      );

      const forced = await send(h.url(), 'POST', copyBody({ overwrite: true }));
      assert.equal(forced.status, 200, JSON.stringify(forced.body));
      assert.match(await h.store.readFile(`${TEAM_ROOT}/notes/deploy.md`), /run-it/);
    } finally {
      await h.close();
    }
  });

  it('9. POST mode:move to the agent tier → source is gone, target exists', async () => {
    const h = await makeHarness();
    try {
      const res = await send(
        h.url(),
        'POST',
        copyBody({ mode: 'move', target: { tier: 'agent' } }),
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(receiptOf(res.body)['targetPath'], `${AGENT_ROOT}/notes/deploy.md`);
      assert.equal(await h.store.fileExists(`${CHANNEL_ROOT}/notes/deploy.md`), false);
      assert.equal(await h.store.fileExists(`${AGENT_ROOT}/notes/deploy.md`), true);
    } finally {
      await h.close();
    }
  });

  it('10. an audit-write failure is logged but never masks the applied promotion', async () => {
    const h = await makeHarness({ breakAuditWrite: true });
    try {
      const res = await send(h.url(), 'POST', copyBody());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(receiptOf(res.body)['targetPath'], `${TEAM_ROOT}/notes/deploy.md`);
      assert.match(String(res.body['warning']), /audit line/i);
      // The promotion itself really landed.
      assert.equal(await h.store.fileExists(`${TEAM_ROOT}/notes/deploy.md`), true);
      assert.ok(h.logs.some((line) => line.includes('[memory-promote]')));
    } finally {
      await h.close();
    }
  });

  it('11. GET with no audit file yet → 200 with an empty entry list', async () => {
    const h = await makeHarness();
    try {
      const res = await send(h.url(), 'GET');
      assert.equal(res.status, 200);
      assert.equal(res.body['auditPath'], PROMOTION_AUDIT_PATH);
      assert.deepEqual(res.body['entries'], []);
    } finally {
      await h.close();
    }
  });

  it('12. GET returns this agent\'s entries newest-first and honours ?limit', async () => {
    const h = await makeHarness();
    try {
      await send(h.url(), 'POST', copyBody());
      await send(
        h.url(),
        'POST',
        copyBody({ source: { axis: 'channel', ctxKey: CHANNEL_KEY, path: 'notes/deploy.md' }, target: { tier: 'agent' }, reason: 'second hop' }),
      );
      // A foreign agent's line and an unparseable line must not leak/throw.
      const raw = await h.store.readFile(PROMOTION_AUDIT_PATH);
      await h.store.writeFile(
        PROMOTION_AUDIT_PATH,
        `${raw}${JSON.stringify({ agentSlug: OTHER_SLUG, actor: 'someone' })}\nnot-json\n`,
      );

      const all = await send(h.url(), 'GET');
      assert.equal(all.status, 200, JSON.stringify(all.body));
      const entries = all.body['entries'] as Array<Record<string, unknown>>;
      assert.equal(entries.length, 2);
      assert.equal(entries[0]?.['reason'], 'second hop', 'newest first');
      assert.equal(entries[1]?.['reason'], 'team-wide runbook');
      assert.ok(entries.every((e) => e['agentSlug'] === SLUG));
      assert.equal(all.body['malformed'], 1);

      const limited = await send(`${h.url()}?limit=1`, 'GET');
      assert.equal(limited.status, 200);
      const one = limited.body['entries'] as Array<Record<string, unknown>>;
      assert.equal(one.length, 1);
      assert.equal(one[0]?.['reason'], 'second hop', 'limit cuts the oldest');
    } finally {
      await h.close();
    }
  });

  it('13. GET with an out-of-range limit → 400 invalid_request', async () => {
    const h = await makeHarness();
    try {
      const res = await send(`${h.url()}?limit=0`, 'GET');
      assert.equal(res.status, 400);
      assert.equal(res.body['error'], 'invalid_request');
      assert.ok(Array.isArray(res.body['issues']));
    } finally {
      await h.close();
    }
  });

  it('14. an invalid agent slug in the path → 400 invalid_agent_slug', async () => {
    const h = await makeHarness();
    try {
      const res = await send(h.url('Not A Slug'), 'POST', copyBody());
      assert.equal(res.status, 400);
      assert.equal(res.body['error'], 'invalid_agent_slug');
    } finally {
      await h.close();
    }
  });
});
