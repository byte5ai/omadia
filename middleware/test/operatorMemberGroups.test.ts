/**
 * `GET /api/v1/operator/memory/contexts/members` — the owner sets of an
 * agent's `members` notes, with who is in each, for the memory browser.
 */
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { InMemoryMemoryStore } from '@omadia/memory';
import { MembersIndex } from '@omadia/orchestrator';

import { createOperatorMemoryContextsRouter } from '../src/routes/operatorMemoryContexts.js';
import type { ResolveMemberNames } from '../src/services/memberNames.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const MOUNT = '/api/v1/operator/memory/contexts';
const SLUG = 'atlas';

async function harness(opts: {
  session?: boolean;
  resolveMemberNames?: ResolveMemberNames;
}): Promise<{ url: (q: string) => string; store: InMemoryMemoryStore; close: () => Promise<void> }> {
  const store = new InMemoryMemoryStore();
  const app = express();
  if (opts.session !== false) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { session: Record<string, string> }).session = { omadia_user_id: 'op-1' };
      next();
    });
  }
  app.use(
    MOUNT,
    createOperatorMemoryContextsRouter({
      store,
      log: () => undefined,
      ...(opts.resolveMemberNames ? { resolveMemberNames: opts.resolveMemberNames } : {}),
    }),
  );
  const server: Server = await listenLoopback(app);
  const { port } = server.address() as AddressInfo;
  return {
    url: (q) => `http://127.0.0.1:${String(port)}${MOUNT}/members${q}`,
    store,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Body {
  groups: Array<{ key: string; path: string; owners: Array<{ id: string; displayName: string | null }> }>;
}

describe('operator memory contexts — members groups', () => {
  it('lists each owner set with the names that resolve', async () => {
    const h = await harness({
      resolveMemberNames: async (ids) =>
        new Map(ids.filter((id) => id === 'u-a').map((id) => [id, { id, displayName: 'Marcel', email: null }])),
    });
    try {
      const key = await new MembersIndex(h.store, SLUG).register(['u-b', 'u-a']);
      const res = await fetch(h.url(`?agent=${SLUG}`));
      assert.equal(res.status, 200);
      const body = (await res.json()) as Body;
      assert.equal(body.groups.length, 1);
      assert.equal(body.groups[0]?.key, key);
      assert.equal(body.groups[0]?.path, `/memories/contexts/${SLUG}/members/${key}`);
      assert.deepEqual(
        body.groups[0]?.owners.map((o) => [o.id, o.displayName]),
        [['u-a', 'Marcel'], ['u-b', null]],
      );
    } finally {
      await h.close();
    }
  });

  it('still answers, ids only, when names cannot be resolved', async () => {
    const h = await harness({ resolveMemberNames: () => Promise.reject(new Error('db down')) });
    try {
      await new MembersIndex(h.store, SLUG).register(['u-a']);
      const body = (await (await fetch(h.url(`?agent=${SLUG}`))).json()) as Body;
      assert.deepEqual(body.groups[0]?.owners, [{ id: 'u-a', displayName: null, email: null }]);
    } finally {
      await h.close();
    }
  });

  it('rejects a missing or path-like agent, and requires a session', async () => {
    const h = await harness({});
    try {
      for (const q of ['', '?agent=', '?agent=../core', '?agent=a%2Fb']) {
        assert.equal((await fetch(h.url(q))).status, 400, `query ${q} was accepted`);
      }
    } finally {
      await h.close();
    }
    const anon = await harness({ session: false });
    try {
      assert.equal((await fetch(anon.url(`?agent=${SLUG}`))).status, 401);
    } finally {
      await anon.close();
    }
  });
});
