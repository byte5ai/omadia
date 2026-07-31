import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import type { Pool } from 'pg';

import {
  createInMemoryPublicMcpKeyBindingAdminStore,
  createPublicMcpKeyBindingAdminStore,
  validateBindingInput,
  type PublicMcpKeyBindingAdminStore,
} from '../../src/mcp/publicMcpKeyBindingsAdmin.js';
import { createPublicMcpBindingsRouter } from '../../src/routes/publicMcpBindingsRouter.js';
import { createInMemoryPublicMcpKeyBindingStore } from '../../src/mcp/publicMcpKeyBindings.js';

/**
 * W5-1 — the admin surface for `public_mcp_key_bindings`.
 *
 * The endpoint shipped in W2-3 was inert: bindings drove every authorization
 * decision and nothing could write one. These tests cover the writer and the
 * operator router that exposes it, and they are pointed at the two ways this
 * unit can go wrong rather than at line coverage:
 *
 *   1. The router is a WRITE path to the table that decides what an
 *      internet-facing API key may do. If its gate is absent or bypassable, the
 *      binding allowlist is decoration. Hence a real express mount with NO
 *      `requireAuth` anywhere — the only arrangement in which a missing gate is
 *      observable at all.
 *   2. If the writer accepts something the reader rejects, the operator gets a
 *      binding that looks configured and grants nothing. Hence the drift tests,
 *      which assert against the READER, not against a copied rule set.
 */

const VALID_INPUT = {
  keyId: 'key-1',
  agentId: 'sales',
  readTools: ['query_crm'],
  writeTools: ['create_lead'],
  writeRateLimitPerMinute: 5,
};

function alwaysValidOperatorAuth(): { hasValidSession(): Promise<boolean> } {
  return { async hasValidSession() { return true; } };
}

function neverValidOperatorAuth(): { hasValidSession(): Promise<boolean> } {
  return { async hasValidSession() { return false; } };
}

/** Mounts the router bare — no `requireAuth`, no parent gate. Anything that
 *  reaches a handler did so through the router's OWN `router.use`. */
function mountRouter(opts: {
  store?: PublicMcpKeyBindingAdminStore | undefined;
  operatorAuth?: { hasValidSession(cookie: string | undefined): Promise<boolean> };
}): { server: Server; baseUrl: string } {
  const app = express();
  app.use(express.json());
  app.use(
    '/public-mcp-bindings',
    createPublicMcpBindingsRouter({
      getStore: () => opts.store,
      ...(opts.operatorAuth ? { operatorAuth: opts.operatorAuth } : {}),
    }),
  );
  const server = app.listen(0);
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${String(addr.port)}/public-mcp-bindings` };
}

/**
 * Runs `fn` against a throwaway mount and ALWAYS closes the listener.
 *
 * Not incidental hygiene — found by the mutation check. Closing after the
 * assertions means a failing assertion skips the close, the listening handle
 * keeps the event loop alive, and `node --test` hangs instead of reporting the
 * failure. A test that hangs when the invariant breaks is not a red test, and
 * under a mutation run it looks like a timeout rather than the specific
 * assertion the mutation was supposed to trip.
 */
async function withRouter(
  opts: Parameters<typeof mountRouter>[0],
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const { server, baseUrl } = mountRouter(opts);
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// ── The gate ────────────────────────────────────────────────────────────────

describe('publicMcpBindingsRouter — fails closed without operatorAuth', () => {
  let server: Server;
  let baseUrl: string;

  before(() => {
    ({ server, baseUrl } = mountRouter({
      store: createInMemoryPublicMcpKeyBindingAdminStore(),
    }));
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('GET / → 503 operator_auth.unavailable', async () => {
    const res = await fetch(baseUrl);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { code: string }).code, 'operator_auth.unavailable');
  });

  /** The one that matters: an unwired host must not leave a write path to the
   *  authorization table open to anyone who can reach the port. */
  it('POST / → 503, and creates NOTHING', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter({ store }, async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(VALID_INPUT),
      });
      assert.equal(res.status, 503);
      assert.deepEqual(await store.list(), [], 'the refused POST must not have written a row');
    });
  });

  it('POST /:keyId/revoke → 503', async () => {
    const res = await fetch(`${baseUrl}/key-1/revoke`, { method: 'POST' });
    assert.equal(res.status, 503);
  });
});

describe('publicMcpBindingsRouter — operator-session gate', () => {
  let server: Server;
  let baseUrl: string;
  let store: PublicMcpKeyBindingAdminStore;

  before(() => {
    store = createInMemoryPublicMcpKeyBindingAdminStore();
    ({ server, baseUrl } = mountRouter({ store, operatorAuth: neverValidOperatorAuth() }));
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('no Cookie header → 401 auth.missing', async () => {
    const res = await fetch(baseUrl);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'auth.missing');
  });

  it('a cookie the accessor rejects → 401 auth.invalid', async () => {
    const res = await fetch(baseUrl, { headers: { cookie: 'omadia_session=nope' } });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'auth.invalid');
  });

  it('an anonymous POST mints no binding', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...VALID_INPUT, keyId: 'anonymous-grant' }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await store.list(), []);
  });

  it('an accessor that THROWS is treated as invalid, never as valid', async () => {
    await withRouter(
      {
        store: createInMemoryPublicMcpKeyBindingAdminStore(),
        operatorAuth: {
          async hasValidSession() {
            throw new Error('accessor blew up');
          },
        },
      },
      async (url) => {
        assert.equal((await fetch(url)).status, 401);
      },
    );
  });
});

// ── CRUD, behind a stubbed-valid gate ───────────────────────────────────────

describe('publicMcpBindingsRouter — CRUD (auth stubbed valid)', () => {
  let server: Server;
  let baseUrl: string;
  let store: PublicMcpKeyBindingAdminStore;

  before(() => {
    store = createInMemoryPublicMcpKeyBindingAdminStore();
    ({ server, baseUrl } = mountRouter({ store, operatorAuth: alwaysValidOperatorAuth() }));
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('POST / creates a binding and GET / lists it', async () => {
    const created = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_INPUT),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { binding: { keyId: string; agentId: string } };
    assert.equal(body.binding.keyId, 'key-1');
    assert.equal(body.binding.agentId, 'sales');

    const listed = (await (await fetch(baseUrl)).json()) as {
      bindings: { keyId: string }[];
    };
    assert.ok(listed.bindings.some((b) => b.keyId === 'key-1'));
  });

  /**
   * The read/write drift guard, at the HTTP boundary. A binding the enforcement
   * path would refuse must be refused at creation too — otherwise the operator
   * saves it, the UI shows it, and the integration silently reaches nothing.
   */
  it('rejects a binding the READER would refuse, with 400 and no row', async () => {
    for (const bad of [
      { ...VALID_INPUT, keyId: 'bad-1', agentId: '' },
      { ...VALID_INPUT, keyId: 'bad-2', readTools: ['ok', 3] },
      { ...VALID_INPUT, keyId: 'bad-3', writeTools: [''] },
    ]) {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bad),
      });
      assert.equal(res.status, 400, `expected 400 for ${bad.keyId}`);
    }
    const listed = (await (await fetch(baseUrl)).json()) as { bindings: { keyId: string }[] };
    assert.ok(!listed.bindings.some((b) => b.keyId.startsWith('bad-')));
  });

  it('rejects a write rate limit past the schema CHECK (0..600) rather than 500-ing on the constraint', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...VALID_INPUT, keyId: 'over', writeRateLimitPerMinute: 601 }),
    });
    assert.equal(res.status, 400);
    assert.equal(
      ((await res.json()) as { code: string }).code,
      'write_rate_limit_out_of_range',
    );
  });

  /**
   * `normalizeBindingRow` resolves a tool named in BOTH lists to WRITE. The
   * admin path persists that resolution, so the row an operator reads back says
   * what the endpoint will actually enforce. Persisting the raw submission
   * would leave `read_tools` naming a tool that in fact requires
   * `mcp:write:<tool>`.
   */
  it('a tool submitted as both read and write is STORED as a write', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...VALID_INPUT,
        keyId: 'both-lists',
        readTools: ['create_lead', 'query_crm'],
        writeTools: ['create_lead'],
      }),
    });
    assert.equal(res.status, 201);
    const { binding } = (await res.json()) as {
      binding: { readTools: string[]; writeTools: string[] };
    };
    assert.deepEqual(binding.readTools, ['query_crm'], 'create_lead must not remain a read');
    assert.deepEqual(binding.writeTools, ['create_lead']);
  });

  it('POST /:keyId/revoke parks the binding WITHOUT deleting it', async () => {
    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...VALID_INPUT, keyId: 'to-revoke' }),
    });

    const revoked = await fetch(`${baseUrl}/to-revoke/revoke`, { method: 'POST' });
    assert.equal(revoked.status, 200);
    const { binding } = (await revoked.json()) as {
      binding: { enabled: boolean; readTools: string[]; writeTools: string[] };
    };
    assert.equal(binding.enabled, false);
    // The point of parking over deleting: the configured reach survives, so an
    // operator can see what the integration used to have and restore it.
    assert.deepEqual(binding.readTools, ['query_crm']);
    assert.deepEqual(binding.writeTools, ['create_lead']);

    const listed = (await (await fetch(baseUrl)).json()) as {
      bindings: { keyId: string; enabled: boolean }[];
    };
    const row = listed.bindings.find((b) => b.keyId === 'to-revoke');
    assert.ok(row, 'the revoked row must still be listed, not deleted');
    assert.equal(row.enabled, false);
  });

  it('POST /:keyId/revoke on an unknown key → 404', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist/revoke`, { method: 'POST' });
    assert.equal(res.status, 404);
  });

  it('503s when there is no store (no graph pool), rather than pretending to save', async () => {
    await withRouter(
      { store: undefined, operatorAuth: alwaysValidOperatorAuth() },
      async (url) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(VALID_INPUT),
        });
        assert.equal(res.status, 503);
        assert.equal(
          ((await res.json()) as { code: string }).code,
          'public_mcp_bindings.unavailable',
        );
      },
    );
  });
});

// ── validateBindingInput: the writer/reader contract ────────────────────────

describe('validateBindingInput — the admin path cannot drift from the reader', () => {
  /**
   * Not a restatement of `publicMcpKeyBindings.test.ts`: that file asserts the
   * READER denies these rows. This one asserts the WRITER denies exactly the
   * same set — the pairing is the anti-drift property. A writer that accepted
   * any of them would persist a row the endpoint ignores.
   */
  for (const [label, input] of [
    ['empty keyId', { ...VALID_INPUT, keyId: '' }],
    ['empty agentId', { ...VALID_INPUT, agentId: '' }],
    ['a non-string in readTools', { ...VALID_INPUT, readTools: ['ok', 7 as unknown as string] }],
    ['an empty string in writeTools', { ...VALID_INPUT, writeTools: [''] }],
  ] as const) {
    it(`rejects ${label} — and so would the reader`, () => {
      const validated = validateBindingInput(input);
      assert.equal(validated.ok, false);

      // The other half of the pairing, proven rather than asserted by comment:
      // hand the same row to the READER and confirm it grants nothing.
      const reader = createInMemoryPublicMcpKeyBindingStore([
        {
          key_id: input.keyId,
          agent_id: input.agentId,
          read_tools: input.readTools,
          write_tools: input.writeTools,
          write_rate_limit_per_minute: input.writeRateLimitPerMinute,
          enabled: true,
        },
      ]);
      return reader.get(input.keyId).then((binding) => {
        assert.equal(binding, undefined, 'reader must refuse what the writer refused');
      });
    });
  }

  it('accepts a binding that grants nothing — an empty allowlist is legitimate', () => {
    const validated = validateBindingInput({
      keyId: 'k',
      agentId: 'a',
      readTools: [],
      writeTools: [],
    });
    assert.equal(validated.ok, true);
  });

  /** A PARKED binding is not an invalid one. `normalizeBindingRow` resolves
   *  `enabled: false` to `undefined` by design, so validating with the
   *  operator's own flag would make "save as disabled" impossible. */
  it('accepts enabled:false — parking is a stored state, not a validation failure', () => {
    const validated = validateBindingInput({ ...VALID_INPUT, enabled: false });
    assert.equal(validated.ok, true);
    assert.equal(validated.ok && validated.value.enabled, false);
  });

  it('defaults the write rate limit to the migration default when omitted', () => {
    const validated = validateBindingInput({
      keyId: 'k',
      agentId: 'a',
      readTools: [],
      writeTools: [],
    });
    assert.equal(validated.ok && validated.value.writeRateLimitPerMinute, 5);
  });
});

// ── updated_at: no trigger exists, so the writer must set it ────────────────

describe('the writer sets updated_at explicitly (migration 0033 has no trigger)', () => {
  /**
   * Asserts against the SQL itself, because that is where the bug lives. The
   * column has `DEFAULT now()` and no trigger, so the default fires on INSERT
   * and never again: an `ON CONFLICT DO UPDATE` that omits `updated_at` leaves
   * it frozen at creation time and the column silently answers "when was this
   * integration's reach last changed?" wrong forever. A fake pool is the only
   * way to see the statement without a live Postgres.
   */
  function recordingPool(): { pool: Pool; statements: string[] } {
    const statements: string[] = [];
    const pool = {
      query(text: string) {
        statements.push(text);
        return Promise.resolve({
          rows: [
            {
              key_id: 'key-1',
              agent_id: 'sales',
              read_tools: ['query_crm'],
              write_tools: ['create_lead'],
              write_rate_limit_per_minute: 5,
              enabled: true,
              created_at: new Date('2026-01-01T00:00:00.000Z'),
              updated_at: new Date('2026-02-02T00:00:00.000Z'),
            },
          ],
          rowCount: 1,
        });
      },
    } as unknown as Pool;
    return { pool, statements };
  }

  /** Collapses whitespace so the assertion survives reformatting of the SQL. */
  function flat(sql: string): string {
    return sql.replace(/\s+/g, ' ');
  }

  it('upsert sets updated_at on the CONFLICT branch, not only via the INSERT default', async () => {
    const { pool, statements } = recordingPool();
    await createPublicMcpKeyBindingAdminStore(pool).upsert(VALID_INPUT);
    assert.equal(statements.length, 1);
    const sql = flat(statements[0] ?? '');
    assert.match(sql, /ON CONFLICT \(key_id\) DO UPDATE SET/);
    assert.match(
      sql.slice(sql.indexOf('DO UPDATE SET')),
      /updated_at = now\(\)/,
      'the DO UPDATE branch must set updated_at — there is no trigger to do it',
    );
  });

  it('setEnabled sets updated_at too — revoking is a change worth timestamping', async () => {
    const { pool, statements } = recordingPool();
    await createPublicMcpKeyBindingAdminStore(pool).setEnabled('key-1', false);
    assert.match(flat(statements[0] ?? ''), /SET enabled = \$2, updated_at = now\(\)/);
  });

  it('the in-memory writer moves updatedAt on an upsert and keeps createdAt', async () => {
    let tick = 0;
    const clock = (): Date => new Date(1_700_000_000_000 + tick++ * 60_000);
    const store = createInMemoryPublicMcpKeyBindingAdminStore([], clock);

    const first = await store.upsert(VALID_INPUT);
    const second = await store.upsert({ ...VALID_INPUT, readTools: ['query_crm', 'read_notes'] });

    assert.equal(second.createdAt, first.createdAt, 'createdAt must survive an update');
    assert.notEqual(second.updatedAt, first.updatedAt, 'updatedAt must move');
    assert.ok(Date.parse(second.updatedAt) > Date.parse(first.updatedAt));
  });

  it('the in-memory writer moves updatedAt on setEnabled', async () => {
    let tick = 0;
    const clock = (): Date => new Date(1_700_000_000_000 + tick++ * 60_000);
    const store = createInMemoryPublicMcpKeyBindingAdminStore([], clock);
    const created = await store.upsert(VALID_INPUT);
    const parked = await store.setEnabled('key-1', false);
    assert.ok(parked);
    assert.ok(Date.parse(parked.updatedAt) > Date.parse(created.updatedAt));
  });

  it('remove reports whether anything was actually deleted', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await store.upsert(VALID_INPUT);
    assert.equal(await store.remove('key-1'), true);
    assert.equal(await store.remove('key-1'), false);
  });
});
