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
  type PublicMcpKeyBindingAdminRow,
  type PublicMcpKeyBindingAdminStore,
} from '../../src/mcp/publicMcpKeyBindingsAdmin.js';
import {
  createPublicMcpBindingsRouter,
  type BindingExistenceCheck,
} from '../../src/routes/publicMcpBindingsRouter.js';
import { createInMemoryPublicMcpKeyBindingStore } from '../../src/mcp/publicMcpKeyBindings.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

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
async function mountRouter(opts: {
  store?: PublicMcpKeyBindingAdminStore | undefined;
  operatorAuth?: { hasValidSession(cookie: string | undefined): Promise<boolean> };
  existence?: BindingExistenceCheck;
}): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use(
    '/public-mcp-bindings',
    createPublicMcpBindingsRouter({
      getStore: () => opts.store,
      ...(opts.operatorAuth ? { operatorAuth: opts.operatorAuth } : {}),
      ...(opts.existence ? { existence: opts.existence } : {}),
    }),
  );
  const server = await listenLoopback(app);
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
  const { server, baseUrl } = await mountRouter(opts);
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** POSTs a binding body verbatim — `unknown` on purpose, because several tests
 *  submit values the TypeScript input type forbids and the wire allows. */
async function postBinding(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── The gate ────────────────────────────────────────────────────────────────

describe('publicMcpBindingsRouter — fails closed without operatorAuth', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    ({ server, baseUrl } = await mountRouter({
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

  before(async () => {
    store = createInMemoryPublicMcpKeyBindingAdminStore();
    ({ server, baseUrl } = await mountRouter({ store, operatorAuth: neverValidOperatorAuth() }));
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

  before(async () => {
    store = createInMemoryPublicMcpKeyBindingAdminStore();
    ({ server, baseUrl } = await mountRouter({ store, operatorAuth: alwaysValidOperatorAuth() }));
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

// ── #571: id existence — a typo must not look configured ─────────────────────

/** A stub `BindingExistenceCheck`. `undefined` for either list models the
 *  "source could not be read" case the router must treat as cannot-tell. */
function existenceOf(
  agents: readonly string[] | undefined,
  keys: readonly string[] | undefined,
): BindingExistenceCheck {
  return {
    async knownAgentIds() {
      return agents ? new Set(agents) : undefined;
    },
    async knownKeyIds() {
      return keys ? new Set(keys) : undefined;
    },
  };
}

function seededRow(keyId: string, agentId: string): PublicMcpKeyBindingAdminRow {
  return {
    keyId,
    agentId,
    readTools: [],
    writeTools: [],
    writeRateLimitPerMinute: 5,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('publicMcpBindingsRouter — #571 id existence (agent hard-reject, key warning)', () => {
  const auth = alwaysValidOperatorAuth();

  it('POST with an agent the registry does not know → 400 agent_not_found, and NO row', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter(
      { store, operatorAuth: auth, existence: existenceOf(['sales'], ['key-1']) },
      async (url) => {
        const res = await postBinding(url, { ...VALID_INPUT, agentId: 'saels' });
        assert.equal(res.status, 400);
        assert.equal(((await res.json()) as { code: string }).code, 'agent_not_found');
        assert.deepEqual(await store.list(), [], "a typo'd agent must not leave a row");
      },
    );
  });

  it('POST with a key the vault does not hold → still created, carrying a key_id_unknown WARNING', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter(
      { store, operatorAuth: auth, existence: existenceOf(['sales'], ['some-other-key']) },
      async (url) => {
        const res = await postBinding(url, VALID_INPUT); // key-1 is not in the vault set
        assert.equal(res.status, 201, 'an unknown key is a warning, not a rejection');
        const { binding } = (await res.json()) as {
          binding: { keyId: string; warnings?: { code: string }[] };
        };
        assert.equal(binding.keyId, 'key-1');
        assert.deepEqual((binding.warnings ?? []).map((w) => w.code), ['key_id_unknown']);
        assert.equal((await store.list()).length, 1, 'the row is stored despite the warning');
      },
    );
  });

  it('POST with BOTH ids unknown → the agent reject wins; no row, no key warning reached', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter(
      { store, operatorAuth: auth, existence: existenceOf(['sales'], ['key-1']) },
      async (url) => {
        const res = await postBinding(url, { keyId: 'ghost', agentId: 'ghost' });
        assert.equal(res.status, 400);
        assert.equal(((await res.json()) as { code: string }).code, 'agent_not_found');
        assert.deepEqual(await store.list(), [], 'a rejected agent must never reach the upsert');
      },
    );
  });

  it('POST with both ids resolvable → 201 and NO warnings field (unchanged happy path)', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter(
      { store, operatorAuth: auth, existence: existenceOf(['sales'], ['key-1']) },
      async (url) => {
        const res = await postBinding(url, VALID_INPUT);
        assert.equal(res.status, 201);
        const { binding } = (await res.json()) as { binding: Record<string, unknown> };
        assert.equal('warnings' in binding, false, 'a clean row serializes exactly as pre-#571');
      },
    );
  });

  it('GET annotates a pre-existing row whose ids no longer resolve — the core "indistinguishable" fix', async () => {
    // Seeded directly, as if the rows were created before this shipped (or by
    // hand in psql): the write path would now reject the agent, but the list
    // must still flag what is already stored.
    const store = createInMemoryPublicMcpKeyBindingAdminStore([
      seededRow('ghost-key', 'ghost-agent'),
      seededRow('key-1', 'sales'),
    ]);
    await withRouter(
      { store, operatorAuth: auth, existence: existenceOf(['sales'], ['key-1']) },
      async (url) => {
        const { bindings } = (await (await fetch(url)).json()) as {
          bindings: { keyId: string; warnings?: { code: string }[] }[];
        };
        const ghost = bindings.find((b) => b.keyId === 'ghost-key');
        assert.ok(ghost, 'the dead row must still be listed');
        assert.deepEqual(
          (ghost.warnings ?? []).map((w) => w.code).sort(),
          ['agent_id_unknown', 'key_id_unknown'],
        );
        const healthy = bindings.find((b) => b.keyId === 'key-1');
        assert.ok(healthy);
        assert.equal('warnings' in healthy, false, 'the healthy row is not annotated');
      },
    );
  });

  it('an unreadable source (undefined sets) neither rejects the agent nor invents warnings', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter(
      { store, operatorAuth: auth, existence: existenceOf(undefined, undefined) },
      async (url) => {
        const res = await postBinding(url, { ...VALID_INPUT, agentId: 'anything' });
        assert.equal(res.status, 201, 'cannot-tell must never become a rejection');
        const { binding } = (await res.json()) as { binding: Record<string, unknown> };
        assert.equal('warnings' in binding, false, 'cannot-tell must not paint a row red');
      },
    );
  });

  it('with no existence wired at all, every id is accepted (pre-#571 behaviour preserved)', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter({ store, operatorAuth: auth }, async (url) => {
      const res = await postBinding(url, { ...VALID_INPUT, agentId: 'whatever' });
      assert.equal(res.status, 201);
    });
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

  /**
   * The FINDING-1 root cause, at the unit that caused it. `enabled: input.enabled
   * ?? true` turned "the operator said nothing about enabled" into "the operator
   * asked for enabled", and the upsert then wrote that `true` over a parked row.
   * An omitted field must stay omitted all the way to the store, which is the
   * only place that knows what the row currently says.
   */
  it('leaves enabled UNSET when omitted — it must never become an implicit true', () => {
    const validated = validateBindingInput(VALID_INPUT);
    assert.equal(validated.ok, true);
    assert.equal(
      validated.ok && validated.value.enabled,
      undefined,
      'omitting enabled must not be silently upgraded to enabled:true',
    );
    assert.equal(
      validated.ok && 'enabled' in validated.value,
      false,
      'the key itself must be absent, so `?? existing` downstream can see the difference',
    );
  });

  it('carries an explicit enabled:true through — re-arming is allowed when asked for', () => {
    const validated = validateBindingInput({ ...VALID_INPUT, enabled: true });
    assert.equal(validated.ok && validated.value.enabled, true);
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

// ── FINDING 1: revoke must not be undone by a save that never mentions it ────

describe('a revoked binding survives an upsert that omits `enabled`', () => {
  /**
   * The composition nobody tested. Two green tests already proved that revoke
   * parks rather than deletes, and that the writer defaults sensibly. Neither
   * asked the only question that matters operationally: after an incident
   * revoke, does the NEXT save — from a stale tab, a second operator, a config
   * replay, or the admin UI's own form, which does not round-trip `enabled` —
   * silently hand the key its whole allowlist back?
   */
  it('store: revoke, then re-save the same binding — still parked', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await store.upsert(VALID_INPUT);
    await store.setEnabled('key-1', false);

    const resaved = await store.upsert({ ...VALID_INPUT, readTools: ['query_crm', 'read_notes'] });

    assert.equal(resaved.binding.enabled, false, 'an omitted `enabled` must not re-arm the key');
    assert.deepEqual(resaved.binding.readTools, ['query_crm', 'read_notes'], 'the edit still lands');
  });

  it('store: an explicit enabled:true is the only way back — and it works', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await store.upsert(VALID_INPUT);
    await store.setEnabled('key-1', false);

    const restored = await store.upsert({ ...VALID_INPUT, enabled: true });
    assert.equal(restored.binding.enabled, true);
  });

  it('store: a fresh row still defaults to enabled — preservation is not "always parked"', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    const created = await store.upsert(VALID_INPUT);
    assert.equal(created.binding.enabled, true);
    assert.equal(created.created, true);
  });

  it('HTTP: POST / over a revoked binding leaves it revoked, and answers 200 not 201', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter({ store, operatorAuth: alwaysValidOperatorAuth() }, async (url) => {
      const created = await postBinding(url, VALID_INPUT);
      assert.equal(created.status, 201, 'a genuinely new binding is Created');

      assert.equal((await fetch(`${url}/key-1/revoke`, { method: 'POST' })).status, 200);

      const resaved = await postBinding(url, { ...VALID_INPUT, writeTools: ['create_lead'] });
      assert.equal(
        resaved.status,
        200,
        '201 Created over an existing row is the operator’s only hint they overwrote one',
      );
      const { binding } = (await resaved.json()) as { binding: { enabled: boolean } };
      assert.equal(binding.enabled, false, 'the parked row must still be parked');

      const listed = (await (await fetch(url)).json()) as {
        bindings: { keyId: string; enabled: boolean }[];
      };
      assert.equal(listed.bindings.find((b) => b.keyId === 'key-1')?.enabled, false);
    });
  });

  it('HTTP: an operator who SAYS enabled:true gets the key back', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter({ store, operatorAuth: alwaysValidOperatorAuth() }, async (url) => {
      await postBinding(url, VALID_INPUT);
      await fetch(`${url}/key-1/revoke`, { method: 'POST' });

      const res = await postBinding(url, { ...VALID_INPUT, enabled: true });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { binding: { enabled: boolean } }).binding.enabled, true);
    });
  });

  /** Un-parking through its own route, so the UI has an affordance that does not
   *  depend on re-submitting the whole binding. */
  it('HTTP: POST /:keyId/restore un-parks, and 404s on an unknown key', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter({ store, operatorAuth: alwaysValidOperatorAuth() }, async (url) => {
      await postBinding(url, VALID_INPUT);
      await fetch(`${url}/key-1/revoke`, { method: 'POST' });

      const res = await fetch(`${url}/key-1/restore`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { binding: { enabled: boolean } }).binding.enabled, true);

      assert.equal((await fetch(`${url}/nope/restore`, { method: 'POST' })).status, 404);
    });
  });

  it('HTTP: restore is gated exactly like every other route', async () => {
    await withRouter(
      {
        store: createInMemoryPublicMcpKeyBindingAdminStore(),
        operatorAuth: neverValidOperatorAuth(),
      },
      async (url) => {
        assert.equal((await fetch(`${url}/key-1/restore`, { method: 'POST' })).status, 401);
      },
    );
  });
});

// ── FINDING 2: JSON null must not coerce to a zero write budget ──────────────

describe('writeRateLimitPerMinute is type-checked, never coerced', () => {
  /**
   * `Number(null)` is `0`, and `0` is a perfectly valid write budget — so a
   * client sending `"writeRateLimitPerMinute": null` to mean "use the default"
   * was stored as a key that authenticates, resolves its binding, and is
   * throttled to nothing on every write, while the UI shows write tools listed.
   * `[]`, `false` and `""` coerce to `0` the same way; `true` coerces to `1`.
   */
  for (const [label, value] of [
    ['null', null],
    ['an empty array', []],
    ['false', false],
    ['an empty string', ''],
    ['true', true],
    ['a numeric string', '5'],
    ['an object', { valueOf: 3 }],
  ] as const) {
    it(`rejects ${label} with 400 rather than coercing it to a budget`, async () => {
      const store = createInMemoryPublicMcpKeyBindingAdminStore();
      await withRouter({ store, operatorAuth: alwaysValidOperatorAuth() }, async (url) => {
        const res = await postBinding(url, { ...VALID_INPUT, writeRateLimitPerMinute: value });
        assert.equal(res.status, 400, `${label} must not be coerced`);
        assert.equal(
          ((await res.json()) as { code: string }).code,
          'write_rate_limit_invalid_type',
        );
        assert.deepEqual(await store.list(), [], 'nothing may be written for a rejected body');
      });
    });
  }

  it('an omitted rate limit still takes the migration default', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter({ store, operatorAuth: alwaysValidOperatorAuth() }, async (url) => {
      const res = await postBinding(url, {
        keyId: 'key-1',
        agentId: 'sales',
        readTools: ['query_crm'],
        writeTools: [],
      });
      assert.equal(res.status, 201);
      const { binding } = (await res.json()) as { binding: { writeRateLimitPerMinute: number } };
      assert.equal(binding.writeRateLimitPerMinute, 5);
    });
  });

  it('an explicit 0 is still honoured — a deliberate zero budget is legitimate', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter({ store, operatorAuth: alwaysValidOperatorAuth() }, async (url) => {
      const res = await postBinding(url, { ...VALID_INPUT, writeRateLimitPerMinute: 0 });
      assert.equal(res.status, 201);
      const { binding } = (await res.json()) as { binding: { writeRateLimitPerMinute: number } };
      assert.equal(binding.writeRateLimitPerMinute, 0);
    });
  });

  /** Same class of bug on the other security-relevant field: a present-but-wrong
   *  `enabled` used to be silently DROPPED, which under the old default meant
   *  "enable it". Silence is not an option for either field. */
  it('rejects a non-boolean `enabled` rather than silently ignoring it', async () => {
    const store = createInMemoryPublicMcpKeyBindingAdminStore();
    await withRouter({ store, operatorAuth: alwaysValidOperatorAuth() }, async (url) => {
      for (const bad of ['false', 0, null, []] as const) {
        const res = await postBinding(url, { ...VALID_INPUT, enabled: bad });
        assert.equal(res.status, 400, `enabled: ${JSON.stringify(bad)} must be refused`);
        assert.equal(((await res.json()) as { code: string }).code, 'enabled_invalid_type');
      }
      assert.deepEqual(await store.list(), []);
    });
  });
});

// ── FINDING 3: driver text must not reach the operator's browser ─────────────

describe('a store failure returns a generic 500, not the driver message', () => {
  function explodingStore(): PublicMcpKeyBindingAdminStore {
    const boom = (): never => {
      throw new Error(
        'relation "public_mcp_key_bindings" does not exist at 10.0.0.7:5432 (constraint pk_key_id)',
      );
    };
    return {
      list: boom,
      upsert: boom,
      setEnabled: boom,
      remove: boom,
    } as unknown as PublicMcpKeyBindingAdminStore;
  }

  for (const [label, call] of [
    ['GET /', (url: string): Promise<Response> => fetch(url)],
    ['POST /', (url: string): Promise<Response> => postBinding(url, VALID_INPUT)],
    [
      'POST /:keyId/revoke',
      (url: string): Promise<Response> => fetch(`${url}/key-1/revoke`, { method: 'POST' }),
    ],
  ] as const) {
    it(`${label} leaks neither table, column, constraint nor host`, async () => {
      await withRouter(
        { store: explodingStore(), operatorAuth: alwaysValidOperatorAuth() },
        async (url) => {
          const res = await call(url);
          assert.equal(res.status, 500);
          const body = await res.text();
          for (const secret of ['public_mcp_key_bindings', '10.0.0.7', 'pk_key_id', 'relation']) {
            assert.ok(
              !body.includes(secret),
              `the 500 body must not carry ${secret} — it lands in devtools and UI logs: ${body}`,
            );
          }
        },
      );
    });
  }
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
  interface RecordedStatement {
    readonly text: string;
    readonly params: readonly unknown[];
  }

  /**
   * Records the SQL **and its bound parameters**.
   *
   * Recording only the text is how this harness was fake-shaped: swapping
   * `setEnabled`'s placeholders to `SET enabled = $1 WHERE key_id = $2` while
   * still passing `[keyId, enabled]` left every text-only assertion green and
   * shipped a revoke that writes the key id into a boolean column and matches
   * rows on `false`. The statement and the array are only meaningful together,
   * so both are captured and `boundTo` below resolves one against the other.
   */
  function recordingPool(): { pool: Pool; statements: RecordedStatement[] } {
    const statements: RecordedStatement[] = [];
    const pool = {
      query(text: string, params?: readonly unknown[]) {
        statements.push({ text, params: params ?? [] });
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
              inserted: false,
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

  /**
   * Resolves what a statement ACTUALLY binds to a named position.
   *
   * `pattern` must capture a `$n` placeholder number; the value returned is the
   * argument the driver would substitute there. This is the assertion the
   * text-only harness could not make: it follows the placeholder the SQL names
   * into the parameter array, so a swap of either side is caught by the other.
   */
  function boundTo(stmt: RecordedStatement, pattern: RegExp): unknown {
    const match = pattern.exec(flat(stmt.text));
    assert.ok(match, `no match for ${String(pattern)} in: ${flat(stmt.text)}`);
    const position = Number(match[1]);
    assert.ok(
      position >= 1 && position <= stmt.params.length,
      `$${String(position)} is out of range for ${String(stmt.params.length)} bound params`,
    );
    return stmt.params[position - 1];
  }

  it('upsert sets updated_at on the CONFLICT branch, not only via the INSERT default', async () => {
    const { pool, statements } = recordingPool();
    await createPublicMcpKeyBindingAdminStore(pool).upsert(VALID_INPUT);
    assert.equal(statements.length, 1);
    const sql = flat(statements[0]?.text ?? '');
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
    assert.match(flat(statements[0]?.text ?? ''), /SET enabled = \$\d+, updated_at = now\(\)/);
  });

  /**
   * The mutation that proved the old harness fake: `SET enabled = $1 WHERE
   * key_id = $2` with the parameter array untouched. Text-only assertions stay
   * green; production revoke breaks. Following each placeholder into the array
   * is what makes the swap visible.
   */
  it('setEnabled binds the key id and the flag to the placeholders its SQL names', async () => {
    const { pool, statements } = recordingPool();
    await createPublicMcpKeyBindingAdminStore(pool).setEnabled('key-1', false);
    const stmt = statements[0];
    assert.ok(stmt);
    assert.equal(
      boundTo(stmt, /SET enabled = \$(\d+)/),
      false,
      'the placeholder the SET clause names must carry the enabled flag',
    );
    assert.equal(
      boundTo(stmt, /WHERE key_id = \$(\d+)/),
      'key-1',
      'the placeholder the WHERE clause names must carry the key id',
    );
  });

  it('upsert binds every column to the placeholder its VALUES list names', async () => {
    const { pool, statements } = recordingPool();
    await createPublicMcpKeyBindingAdminStore(pool).upsert({ ...VALID_INPUT, enabled: false });
    const stmt = statements[0];
    assert.ok(stmt);
    // The VALUES list is positional, so resolve it once and check the row it
    // would actually write rather than trusting the argument order.
    const values = /VALUES \(([^)]*)\)/.exec(flat(stmt.text))?.[1] ?? '';
    const positions = [...values.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const bound = positions.map((p) => stmt.params[p - 1]);
    assert.deepEqual(bound.slice(0, 5), ['key-1', 'sales', ['query_crm'], ['create_lead'], 5]);
    assert.equal(bound[5], false, 'the enabled column must bind the operator flag');
  });

  /**
   * FINDING 1 in SQL. The conflict branch must resolve an unspecified `enabled`
   * against the STORED column. Two ways to get this wrong and both are checked:
   * binding `true` instead of NULL (nothing left to preserve), and coalescing
   * against `EXCLUDED.enabled` — which holds the row this very statement
   * proposed, so it resolves straight back to the insert branch's `true` and
   * re-arms the binding it was supposed to leave parked.
   */
  it('upsert binds NULL for an omitted enabled and coalesces it against the STORED column', async () => {
    const { pool, statements } = recordingPool();
    await createPublicMcpKeyBindingAdminStore(pool).upsert(VALID_INPUT);
    const stmt = statements[0];
    assert.ok(stmt);

    const doUpdate = flat(stmt.text).slice(flat(stmt.text).indexOf('DO UPDATE SET'));
    // Everything the conflict branch assigns to `enabled`, up to the next
    // `<column> = ` assignment. A plain `[^,]+` would stop at the comma INSIDE
    // `COALESCE(a, b)` and read the preservation as if it were absent.
    const conflictEnabled = /\benabled = (.+?)(?=, [a-z_]+ = |RETURNING)/.exec(doUpdate)?.[1] ?? '';
    assert.match(
      conflictEnabled,
      /public_mcp_key_bindings\.enabled/,
      'the conflict branch must fall back to the stored column, not to EXCLUDED',
    );
    assert.ok(
      !/EXCLUDED\.enabled/.test(conflictEnabled),
      'EXCLUDED.enabled is the proposed row — coalescing against it preserves nothing',
    );

    const position = Number(/\$(\d+)/.exec(conflictEnabled)?.[1]);
    assert.equal(
      stmt.params[position - 1],
      null,
      'an omitted enabled must bind NULL, so COALESCE has something to fall through',
    );
  });

  it('the in-memory writer moves updatedAt on an upsert and keeps createdAt', async () => {
    let tick = 0;
    const clock = (): Date => new Date(1_700_000_000_000 + tick++ * 60_000);
    const store = createInMemoryPublicMcpKeyBindingAdminStore([], clock);

    const first = (await store.upsert(VALID_INPUT)).binding;
    const second = (await store.upsert({ ...VALID_INPUT, readTools: ['query_crm', 'read_notes'] }))
      .binding;

    assert.equal(second.createdAt, first.createdAt, 'createdAt must survive an update');
    assert.notEqual(second.updatedAt, first.updatedAt, 'updatedAt must move');
    assert.ok(Date.parse(second.updatedAt) > Date.parse(first.updatedAt));
  });

  it('the in-memory writer moves updatedAt on setEnabled', async () => {
    let tick = 0;
    const clock = (): Date => new Date(1_700_000_000_000 + tick++ * 60_000);
    const store = createInMemoryPublicMcpKeyBindingAdminStore([], clock);
    const created = (await store.upsert(VALID_INPUT)).binding;
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
