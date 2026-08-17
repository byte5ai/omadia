import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { MCP_INVOKE_SCOPE, MCP_LIST_SCOPE, mcpWriteScope, WILDCARD_SCOPE } from '@omadia/api-key-auth';
// From source (not the `@omadia/channel-sdk` dist barrel): added in #647, after
// the last dist build.
import {
  AI_PROVENANCE_HEADER,
  AI_PROVENANCE_META_KEY,
  ENVELOPE_PROVENANCE,
} from '../../packages/harness-channel-sdk/src/provenance.js';

import { MAX_REQUEST_BYTES } from '../../src/mcp/publicMcpServer.js';
import { PUBLIC_MCP_PATH } from '../../src/mcp/publicMcpPath.js';
import type { PublicMcpAuditEntry } from '../../src/mcp/publicMcpServer.js';
import {
  callResultText,
  maskingPrivacyService,
  callToolRequest,
  fakeDispatcher,
  isSandboxListenDenied,
  listToolsRequest,
  rpcErrorMessage,
  startHarness,
  toolNames,
  type Harness,
  type HarnessOptions,
} from './harness.js';

/**
 * W2-3 (issue #542) — end-to-end proof for the public, stateless MCP endpoint.
 *
 * Driven against the REAL middleware chain (`express.json` at 10mb → the OB-106
 * `/api` requireAuth line → `mountPublicMcp`, the same function index.ts calls
 * → the shared `publicPaths` allowlist). See `harness.ts` for why a bare
 * `express()` app would have proven nothing.
 *
 * Every request below is stateless: no `initialize`, no `notifications/
 * initialized`, no `Mcp-Session-Id`. That is the premise of the issue — any
 * process must be able to answer any request — and it is asserted directly in
 * the "statelessness" block.
 */

const READ_TOOL = 'query_crm';
const WRITE_TOOL = 'create_lead';
const OTHER_TOOL = 'query_hr';

const KEY_TOKEN = 'omadia_ak_test_token_aaaaaaaaaaaaaaaa';
const KEY_ID = 'key-sales';

/**
 * The endpoint advertises name-SORTED, so the wire order is a property of the
 * server rather than of whichever order the binding or the dispatcher happened
 * to iterate in (plugin load order and `created_at` row order differ across
 * machines). Derived here rather than hand-listed, so this stays correct if the
 * tool names above are ever renamed.
 */
const SORTED_TOOLS = [READ_TOOL, WRITE_TOOL].slice().sort();

function baseOptions(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    keys: [
      {
        token: KEY_TOKEN,
        id: KEY_ID,
        scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE, mcpWriteScope(WRITE_TOOL)],
      },
    ],
    bindingRows: [
      {
        key_id: KEY_ID,
        agent_id: 'sales',
        read_tools: [READ_TOOL],
        write_tools: [WRITE_TOOL],
        write_rate_limit_per_minute: 5,
        enabled: true,
      },
    ],
    dispatchers: {
      sales: fakeDispatcher([{ name: READ_TOOL }, { name: WRITE_TOOL }]),
    },
    ...overrides,
  };
}

describe('public MCP endpoint', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function start(opts: HarnessOptions, t: { skip: (m: string) => void }): Promise<Harness | undefined> {
    try {
      harness = await startHarness(opts);
      return harness;
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return undefined;
      }
      throw error;
    }
  }

  // ── authentication ────────────────────────────────────────────────────────

  it('401s with no Authorization header', async (t) => {
    const h = await start(baseOptions(), t);
    if (!h) return;
    const res = await h.post(listToolsRequest());
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, 'unauthorized');
  });

  it('401s with an unknown bearer token', async (t) => {
    const h = await start(baseOptions(), t);
    if (!h) return;
    const res = await h.post(listToolsRequest(), { token: 'omadia_ak_wrong_token_bbbbbbbbbbbb' });
    assert.equal(res.status, 401);
  });

  /**
   * The `publicPaths` entry is LOAD-BEARING, and its failure mode must be dark
   * rather than open. Strip it and the blanket `/api` requireAuth line answers
   * 401 with the SESSION gate's error shape (`{code}`), never reaching
   * `requireApiKey` (`{error}`) — which is how we know the two are distinct
   * layers and not one duplicated check.
   */
  it('goes DARK (session 401), not open, when the publicPaths entry is removed', async (t) => {
    const h = await start(baseOptions({ withoutPublicPathEntry: true }), t);
    if (!h) return;
    const res = await h.post(listToolsRequest(), { token: KEY_TOKEN });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { code?: string; error?: string };
    assert.equal(body.error, undefined, 'must not have reached requireApiKey');
    assert.ok(body.code?.startsWith('auth.'), `expected a session-gate code, got ${JSON.stringify(body)}`);
  });

  // ── method + payload limits ───────────────────────────────────────────────

  /** A per-request transport LEAKS on GET: an SSE stream never ends, so
   *  `handleRequest` never resolves and the teardown `finally` never runs. */
  it('405s a non-POST request and advertises Allow: POST', async (t) => {
    const h = await start(baseOptions(), t);
    if (!h) return;
    const res = await fetch(h.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${KEY_TOKEN}`, Accept: 'text/event-stream' },
    });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
    await res.text();
  });

  it('413s a body over the 8 MB cap', async (t) => {
    const h = await start(baseOptions(), t);
    if (!h) return;
    // Over 8 MB, under the kernel's 10 MB express.json limit, so this exercises
    // THIS cap rather than express's.
    const big = 'x'.repeat(MAX_REQUEST_BYTES + 1024);
    const res = await h.post(callToolRequest(READ_TOOL, { blob: big }), { token: KEY_TOKEN });
    assert.equal(res.status, 413);
    await res.text();
  });

  // The `Content-Length` fast path is not reachable end-to-end: a header
  // declaring 8-10 MB while sending a small body leaves `express.json` waiting
  // for the rest, and `fetch` will not send a mismatched one anyway. It is unit-
  // tested directly in `publicMcpBodyCap.test.ts`, where the honest boundary is.

  it('serves a normal-sized body', async (t) => {
    const h = await start(baseOptions(), t);
    if (!h) return;
    const { status, payload } = await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    assert.equal(status, 200);
    assert.deepEqual(toolNames(payload), SORTED_TOOLS);
    // #545 — MCP 2026-07-28 CacheableResult: the list is filtered per API key,
    // so `private` is mandatory (sharing it across auth contexts would leak
    // other keys' tool sets), and the TTL stays short so a revoked binding
    // does not linger in cached lists.
    const result = (payload as { result?: { ttlMs?: unknown; cacheScope?: unknown } }).result;
    assert.equal(result?.ttlMs, 60_000);
    assert.equal(result?.cacheScope, 'private');
  });

  // ── statelessness ─────────────────────────────────────────────────────────

  /**
   * THE headline guarantee. Two sequential `tools/call`s, each answered by a
   * FRESH `Server` + transport pair, with no session header on either. A shared
   * transport makes only the first work — the SDK throws "Stateless transport
   * cannot be reused across requests" — so a regression here shows up as the
   * SECOND call failing while the first still passes.
   */
  it('answers two sequential tools/call requests with no session header', async (t) => {
    const h = await start(baseOptions(), t);
    if (!h) return;

    const first = await h.rpc(callToolRequest(READ_TOOL, { q: 'one' }, 10), { token: KEY_TOKEN });
    assert.equal(first.status, 200, `first call failed: ${JSON.stringify(first.payload)}`);
    assert.equal(callResultText(first.payload), `dispatched:${READ_TOOL}`);

    const second = await h.rpc(callToolRequest(READ_TOOL, { q: 'two' }, 11), { token: KEY_TOKEN });
    assert.equal(second.status, 200, `second call failed: ${JSON.stringify(second.payload)}`);
    assert.equal(callResultText(second.payload), `dispatched:${READ_TOOL}`);
  });

  it('never issues an Mcp-Session-Id', async (t) => {
    const h = await start(baseOptions(), t);
    if (!h) return;
    const res = await h.post(listToolsRequest(), { token: KEY_TOKEN });
    assert.equal(res.headers.get('mcp-session-id'), null);
    await res.text();
  });

  // ── tools/list must leak nothing ──────────────────────────────────────────

  it('errors tools/list for a key without mcp:list, leaking no names', async (t) => {
    const h = await start(
      baseOptions({
        keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_INVOKE_SCOPE] }],
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    const message = rpcErrorMessage(payload) ?? '';
    assert.match(message, new RegExp(MCP_LIST_SCOPE));
    assert.doesNotMatch(message, new RegExp(READ_TOOL));
    assert.doesNotMatch(message, new RegExp(WRITE_TOOL));
  });

  /** `tools/list` returns the CALLABLE set, not the visible-in-principle set.
   *  A key that can list but not invoke can call nothing, so it sees nothing. */
  it('returns an EMPTY list for a key with mcp:list but no mcp:invoke', async (t) => {
    const h = await start(
      baseOptions({ keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_LIST_SCOPE] }] }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    assert.deepEqual(toolNames(payload), []);
  });

  it('hides a write tool from tools/list when the per-tool write scope is absent', async (t) => {
    const h = await start(
      baseOptions({
        keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] }],
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    assert.deepEqual(toolNames(payload), [READ_TOOL]);
  });

  /** `*` grants list and invoke, and must NOT reveal a write tool. */
  it('WILDCARD_SCOPE does not reveal a write tool in tools/list', async (t) => {
    const h = await start(
      baseOptions({ keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [WILDCARD_SCOPE] }] }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    assert.deepEqual(toolNames(payload), [READ_TOOL]);
  });

  it('never lists a tool the agent advertises but the binding omits', async (t) => {
    const h = await start(
      baseOptions({
        dispatchers: {
          sales: fakeDispatcher([{ name: READ_TOOL }, { name: WRITE_TOOL }, { name: 'secret_tool' }]),
        },
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    assert.deepEqual(toolNames(payload), SORTED_TOOLS);
  });

  it('never lists a binding entry the agent does not advertise', async (t) => {
    const h = await start(
      baseOptions({
        bindingRows: [
          {
            key_id: KEY_ID,
            agent_id: 'sales',
            read_tools: [READ_TOOL, 'tool_that_does_not_exist'],
            write_tools: [WRITE_TOOL],
            write_rate_limit_per_minute: 5,
            enabled: true,
          },
        ],
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    assert.deepEqual(toolNames(payload), SORTED_TOOLS);
  });

  it('returns an empty list for a key with no binding at all', async (t) => {
    const h = await start(baseOptions({ bindingRows: [] }), t);
    if (!h) return;
    const { payload } = await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    assert.deepEqual(toolNames(payload), []);
  });

  // ── tools/call authorization ──────────────────────────────────────────────

  it('calls an allowlisted read tool', async (t) => {
    const seen: { name: string; input: unknown }[] = [];
    const h = await start(
      baseOptions({
        dispatchers: { sales: fakeDispatcher([{ name: READ_TOOL }, { name: WRITE_TOOL }], seen) },
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(READ_TOOL, { q: 'x' }), { token: KEY_TOKEN });
    assert.equal(callResultText(payload), `dispatched:${READ_TOOL}`);
    assert.deepEqual(seen, [{ name: READ_TOOL, input: { q: 'x' } }]);
  });

  // ── #647: AI-Act Art. 50 provenance on the envelope ──────────────────────
  // The analogue of the chat API's header + done-event marking. Read back off
  // the produced response, not the handler input.

  it('sets the AI-Act provenance header on every response, including tools/list', async (t) => {
    const h = await start(baseOptions(), t);
    if (!h) return;
    // Connection level: present on a listing too, since the header marks the
    // endpoint as an AI system rather than a single tool result's data.
    const list = await h.post(listToolsRequest(), { token: KEY_TOKEN });
    assert.equal(list.headers.get(AI_PROVENANCE_HEADER), 'true');
    await list.text();

    const call = await h.post(callToolRequest(READ_TOOL, { q: 'x' }), { token: KEY_TOKEN });
    assert.equal(call.headers.get(AI_PROVENANCE_HEADER), 'true');
    await call.text();
  });

  it('carries the provenance marker in the tools/call result _meta', async (t) => {
    const h = await start(baseOptions(), t);
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(READ_TOOL, { q: 'x' }), { token: KEY_TOKEN });
    // Read the marker out of the actual JSON-RPC result envelope.
    const result = payload['result'] as { _meta?: Record<string, unknown> } | undefined;
    assert.deepEqual(result?._meta?.[AI_PROVENANCE_META_KEY], ENVELOPE_PROVENANCE);
    // And the additive field left the rest of the result intact.
    assert.equal(callResultText(payload), `dispatched:${READ_TOOL}`);
  });

  it('calls a write tool when the per-tool write scope is present', async (t) => {
    const h = await start(baseOptions(), t);
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(WRITE_TOOL), { token: KEY_TOKEN });
    assert.equal(callResultText(payload), `dispatched:${WRITE_TOOL}`);
  });

  /** THE merge blocker: `mcp:invoke` is not sufficient for a write. */
  it('refuses a write tool for a key holding only mcp:invoke — and never dispatches it', async (t) => {
    const seen: { name: string; input: unknown }[] = [];
    const h = await start(
      baseOptions({
        keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] }],
        dispatchers: { sales: fakeDispatcher([{ name: READ_TOOL }, { name: WRITE_TOOL }], seen) },
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(WRITE_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /not available to this API key/);
    assert.deepEqual(seen, [], 'the tool must never have been dispatched');
  });

  /** THE second merge blocker: `*` does not grant a write. */
  it('refuses a write tool for a WILDCARD_SCOPE key — and never dispatches it', async (t) => {
    const seen: { name: string; input: unknown }[] = [];
    const h = await start(
      baseOptions({
        keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [WILDCARD_SCOPE] }],
        dispatchers: { sales: fakeDispatcher([{ name: READ_TOOL }, { name: WRITE_TOOL }], seen) },
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(WRITE_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /not available to this API key/);
    assert.deepEqual(seen, []);
  });

  it('refuses a write scope for a DIFFERENT tool', async (t) => {
    const h = await start(
      baseOptions({
        keys: [
          {
            token: KEY_TOKEN,
            id: KEY_ID,
            scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE, mcpWriteScope('some_other_tool')],
          },
        ],
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(WRITE_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /not available to this API key/);
  });

  /** A non-allowlisted tool and a nonexistent tool must be INDISTINGUISHABLE —
   *  distinguishing them confirms a tool's existence to a caller not entitled
   *  to know it. */
  it('gives the same answer for a non-allowlisted tool and a nonexistent one', async (t) => {
    const h = await start(
      baseOptions({
        dispatchers: {
          sales: fakeDispatcher([{ name: READ_TOOL }, { name: WRITE_TOOL }, { name: OTHER_TOOL }]),
        },
      }),
      t,
    );
    if (!h) return;
    const existing = await h.rpc(callToolRequest(OTHER_TOOL), { token: KEY_TOKEN });
    const absent = await h.rpc(callToolRequest('no_such_tool_anywhere'), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(existing.payload) ?? '', /not available to this API key/);
    assert.match(rpcErrorMessage(absent.payload) ?? '', /not available to this API key/);
    assert.equal(
      (rpcErrorMessage(existing.payload) ?? '').replace(OTHER_TOOL, 'T'),
      (rpcErrorMessage(absent.payload) ?? '').replace('no_such_tool_anywhere', 'T'),
    );
  });

  it('refuses every call for a key with no binding', async (t) => {
    const h = await start(baseOptions({ bindingRows: [] }), t);
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /not available to this API key/);
  });

  // ── W4: list and call use ONE predicate ───────────────────────────────────

  /**
   * The two paths used to disagree. `tools/list` returned
   * `listDispatchableToolSpecs() ∩ callableToolNames`, while `tools/call`
   * authorized on `callableToolNames` alone and then dispatched by raw name. A
   * tool named in a binding but NOT advertised by the agent was therefore hidden
   * from list yet ACCEPTED by call — failing deep in the dispatcher as
   * "unknown tool" instead of the uniform refusal.
   *
   * List being stricter is the safe direction, so this is not itself a
   * privilege escalation. What it IS is an oracle: the two error shapes let a
   * caller separate "named in your binding but unavailable" from "not in your
   * binding" and map the binding's contents one probe at a time — the exact
   * enumeration the identical-message rule exists to prevent.
   */
  const PHANTOM_TOOL = 'query_phantom';

  function phantomBinding(): Partial<HarnessOptions> {
    return {
      bindingRows: [
        {
          key_id: KEY_ID,
          agent_id: 'sales',
          // Named by the operator; the agent does not advertise it.
          read_tools: [READ_TOOL, PHANTOM_TOOL],
          write_tools: [WRITE_TOOL],
          write_rate_limit_per_minute: 5,
          enabled: true,
        },
      ],
      dispatchers: {
        sales: fakeDispatcher([{ name: READ_TOOL }, { name: WRITE_TOOL }]),
      },
    };
  }

  it('refuses a binding entry the agent does not advertise, with the UNIFORM message', async (t) => {
    const h = await start(baseOptions(phantomBinding()), t);
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(PHANTOM_TOOL), { token: KEY_TOKEN });
    const message = rpcErrorMessage(payload) ?? '';
    assert.match(message, /not available to this API key/);
    assert.doesNotMatch(message, /unknown tool/, 'the dispatcher-level error is a binding oracle');
  });

  it('gives a BYTE-IDENTICAL answer for an unadvertised binding entry and a name not in the binding', async (t) => {
    // The oracle, closed. Normalizing the tool name out is the only difference
    // permitted between the two replies.
    const h = await start(baseOptions(phantomBinding()), t);
    if (!h) return;
    const inBinding = await h.rpc(callToolRequest(PHANTOM_TOOL, {}, 1), { token: KEY_TOKEN });
    const notInBinding = await h.rpc(callToolRequest('never_heard_of_it', {}, 1), {
      token: KEY_TOKEN,
    });
    assert.equal(
      JSON.stringify(inBinding.payload).replaceAll(PHANTOM_TOOL, 'T'),
      JSON.stringify(notInBinding.payload).replaceAll('never_heard_of_it', 'T'),
    );
  });

  it('never DISPATCHES an unadvertised binding entry', async (t) => {
    // Authorization must refuse it, not the dispatcher. Otherwise a
    // not-yet-ready plugin's tool reaches dispatch on every probe.
    const seen: { name: string; input: unknown }[] = [];
    const h = await start(
      baseOptions({
        ...phantomBinding(),
        dispatchers: {
          sales: fakeDispatcher([{ name: READ_TOOL }, { name: WRITE_TOOL }], seen),
        },
      }),
      t,
    );
    if (!h) return;
    await h.rpc(callToolRequest(PHANTOM_TOOL), { token: KEY_TOKEN });
    assert.deepEqual(seen, []);
  });

  it('list and call agree exactly: every listed tool is callable and nothing else is', async (t) => {
    // The invariant the module header claims, asserted as an invariant rather
    // than as two separate examples.
    const h = await start(baseOptions(phantomBinding()), t);
    if (!h) return;
    const listed = toolNames((await h.rpc(listToolsRequest(), { token: KEY_TOKEN })).payload) ?? [];
    assert.deepEqual(listed, SORTED_TOOLS, 'the phantom must not be listed');

    for (const name of listed) {
      const { payload } = await h.rpc(callToolRequest(name, {}, 2), { token: KEY_TOKEN });
      assert.equal(
        rpcErrorMessage(payload),
        undefined,
        `listed tool ${name} was refused by the call path`,
      );
    }
    for (const name of [PHANTOM_TOOL, 'never_heard_of_it']) {
      const { payload } = await h.rpc(callToolRequest(name, {}, 3), { token: KEY_TOKEN });
      assert.match(
        rpcErrorMessage(payload) ?? '',
        /not available to this API key/,
        `unlisted tool ${name} was accepted by the call path`,
      );
    }
  });

  it('refuses every call for a DISABLED binding', async (t) => {
    const h = await start(
      baseOptions({
        bindingRows: [
          {
            key_id: KEY_ID,
            agent_id: 'sales',
            read_tools: [READ_TOOL],
            write_tools: [],
            write_rate_limit_per_minute: 5,
            enabled: false,
          },
        ],
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /not available to this API key/);
  });

  // ── key → agent isolation ─────────────────────────────────────────────────

  /**
   * omadia's native tool registry is process-wide with unique names, so "agent
   * isolation" cannot come from the registry. It comes from the binding row
   * naming ONE agent plus the allowlist. Two keys, two agents, two tool sets:
   * neither key may reach the other's tool, and the refusal must happen before
   * the other agent's dispatcher is ever consulted.
   */
  it('key A cannot reach agent B\'s tools', async (t) => {
    const seenA: { name: string; input: unknown }[] = [];
    const seenB: { name: string; input: unknown }[] = [];
    const tokenB = 'omadia_ak_test_token_cccccccccccccccc';
    const h = await start(
      baseOptions({
        keys: [
          { token: KEY_TOKEN, id: 'key-a', scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] },
          { token: tokenB, id: 'key-b', scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] },
        ],
        bindingRows: [
          {
            key_id: 'key-a',
            agent_id: 'sales',
            read_tools: [READ_TOOL],
            write_tools: [],
            write_rate_limit_per_minute: 5,
            enabled: true,
          },
          {
            key_id: 'key-b',
            agent_id: 'hr',
            read_tools: [OTHER_TOOL],
            write_tools: [],
            write_rate_limit_per_minute: 5,
            enabled: true,
          },
        ],
        dispatchers: {
          sales: fakeDispatcher([{ name: READ_TOOL }], seenA),
          hr: fakeDispatcher([{ name: OTHER_TOOL }], seenB),
        },
      }),
      t,
    );
    if (!h) return;

    // Each key sees only its own agent's tool.
    assert.deepEqual(toolNames((await h.rpc(listToolsRequest(), { token: KEY_TOKEN })).payload), [
      READ_TOOL,
    ]);
    assert.deepEqual(toolNames((await h.rpc(listToolsRequest(), { token: tokenB })).payload), [
      OTHER_TOOL,
    ]);

    // Key A naming agent B's tool is refused, and B's dispatcher is untouched.
    const crossed = await h.rpc(callToolRequest(OTHER_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(crossed.payload) ?? '', /not available to this API key/);
    assert.deepEqual(seenB, [], "agent B's dispatcher must never have been reached");

    // And each key's own call still works, so the isolation is not just breakage.
    assert.equal(
      callResultText((await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN })).payload),
      `dispatched:${READ_TOOL}`,
    );
    assert.equal(
      callResultText((await h.rpc(callToolRequest(OTHER_TOOL), { token: tokenB })).payload),
      `dispatched:${OTHER_TOOL}`,
    );
  });

  it('fails closed when the bound agent is not active', async (t) => {
    const h = await start(baseOptions({ dispatchers: {} }), t);
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /not available to this API key/);
  });

  // ── rate limits: reads and writes on SEPARATE budgets ─────────────────────

  it('exhausts the write budget while READS keep working', async (t) => {
    const h = await start(
      baseOptions({
        bindingRows: [
          {
            key_id: KEY_ID,
            agent_id: 'sales',
            read_tools: [READ_TOOL],
            write_tools: [WRITE_TOOL],
            write_rate_limit_per_minute: 2,
            enabled: true,
          },
        ],
      }),
      t,
    );
    if (!h) return;

    for (const attempt of [1, 2]) {
      const ok = await h.rpc(callToolRequest(WRITE_TOOL, {}, attempt), { token: KEY_TOKEN });
      assert.equal(callResultText(ok.payload), `dispatched:${WRITE_TOOL}`, `write ${String(attempt)}`);
    }
    const over = await h.rpc(callToolRequest(WRITE_TOOL, {}, 3), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(over.payload) ?? '', /write rate limit exceeded/);

    // The READ budget is a different bucket entirely — it must be untouched.
    const read = await h.rpc(callToolRequest(READ_TOOL, {}, 4), { token: KEY_TOKEN });
    assert.equal(callResultText(read.payload), `dispatched:${READ_TOOL}`);
  });

  /** The general per-key budget `requireApiKey` applies is separate again, and
   *  exhausting it stops EVERYTHING including tools/list — with an HTTP 429,
   *  not a JSON-RPC error, because it is enforced before the transport. */
  it('exhausts the general per-key budget with an HTTP 429', async (t) => {
    const h = await start(
      baseOptions({
        keys: [
          {
            token: KEY_TOKEN,
            id: KEY_ID,
            scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE],
            rateLimitPerMinute: 2,
          },
        ],
      }),
      t,
    );
    if (!h) return;
    assert.equal((await h.post(listToolsRequest(), { token: KEY_TOKEN })).status, 200);
    assert.equal((await h.post(listToolsRequest(), { token: KEY_TOKEN })).status, 200);
    const over = await h.post(listToolsRequest(), { token: KEY_TOKEN });
    assert.equal(over.status, 429);
    await over.text();
  });

  it('a write budget of 0 refuses every write while reads still work', async (t) => {
    const h = await start(
      baseOptions({
        bindingRows: [
          {
            key_id: KEY_ID,
            agent_id: 'sales',
            read_tools: [READ_TOOL],
            write_tools: [WRITE_TOOL],
            write_rate_limit_per_minute: 0,
            enabled: true,
          },
        ],
      }),
      t,
    );
    if (!h) return;
    const write = await h.rpc(callToolRequest(WRITE_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(write.payload) ?? '', /write rate limit exceeded/);
    const read = await h.rpc(callToolRequest(READ_TOOL, {}, 9), { token: KEY_TOKEN });
    assert.equal(callResultText(read.payload), `dispatched:${READ_TOOL}`);
  });

  // ── internal errors must not reach the caller ─────────────────────────────

  // `handleHttp` has a catch that answers a bare "Internal server error", and it
  // is UNREACHABLE for anything a request handler throws: the SDK converts a
  // handler rejection into a JSON-RPC error built from `error.message` and then
  // resolves, so the raw text is already on the wire before that catch could
  // run. A failing binding query therefore handed an external caller a Postgres
  // diagnostic naming the relation, the host, or the driver.
  it('does not leak a store failure message to the caller', async (t) => {
    const leaky = 'relation "public_mcp_key_bindings" does not exist at db-prod-7.internal:5432';
    const h = await start(
      baseOptions({
        bindingStore: {
          get: () => Promise.reject(new Error(leaky)),
        } as unknown as Parameters<typeof baseOptions>[0]['bindingStore'],
      }),
      t,
    );
    if (!h) return;

    const { payload } = await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    const message = rpcErrorMessage(payload) ?? '';
    assert.doesNotMatch(message, /public_mcp_key_bindings/, 'leaked the relation name');
    assert.doesNotMatch(message, /db-prod-7\.internal/, 'leaked an internal hostname');
    assert.match(message, /Internal server error/);
  });

  it('does not leak a store failure message through tools/list either', async (t) => {
    const leaky = 'password authentication failed for user "omadia" on db-prod-7.internal';
    const h = await start(
      baseOptions({
        bindingStore: {
          get: () => Promise.reject(new Error(leaky)),
        } as unknown as Parameters<typeof baseOptions>[0]['bindingStore'],
      }),
      t,
    );
    if (!h) return;

    const { payload } = await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    const message = rpcErrorMessage(payload) ?? '';
    assert.doesNotMatch(message, /password authentication/, 'leaked a credential diagnostic');
    assert.doesNotMatch(message, /db-prod-7\.internal/, 'leaked an internal hostname');
  });

  // ── timeout + concurrency ─────────────────────────────────────────────────

  it('times out a hanging tool without hanging the request', async (t) => {
    const h = await start(
      baseOptions({
        toolTimeoutMs: 60,
        dispatchers: {
          sales: fakeDispatcher([
            { name: READ_TOOL, handle: () => new Promise(() => {/* never settles */}) },
          ]),
        },
      }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /exceeded the 60ms public MCP timeout/);
  });

  // The timeout answers the CALLER; it does not cancel the work — nothing in
  // ToolDispatchService accepts an AbortSignal, and the loser of a Promise.race
  // keeps running. So the slot must stay held until the work actually settles.
  // Releasing it when the race settled meant a caller hammering a tool that
  // hangs on an upstream connection reopened a slot every timeout while every
  // one of those calls stayed alive — unbounded sockets and external work
  // behind a ceiling that still claimed to be `maxConcurrentCalls`.
  it('keeps the concurrency slot held after a timeout, until the work settles', async (t) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await start(
      baseOptions({
        maxConcurrentCalls: 1,
        toolTimeoutMs: 60,
        dispatchers: {
          sales: fakeDispatcher([
            {
              name: READ_TOOL,
              handle: async () => {
                await gate;
                return { content: 'eventually' };
              },
            },
          ]),
        },
      }),
      t,
    );
    if (!h) return;

    // First call times out — but its work is still running behind the gate.
    const first = await h.rpc(callToolRequest(READ_TOOL, {}, 30), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(first.payload) ?? '', /exceeded the 60ms public MCP timeout/);

    // The slot must NOT have reopened: the abandoned call still occupies it.
    const second = await h.rpc(callToolRequest(READ_TOOL, {}, 31), { token: KEY_TOKEN });
    assert.match(
      rpcErrorMessage(second.payload) ?? '',
      /at capacity/,
      'a timed-out call still running must keep holding its slot',
    );

    // Once the abandoned work finally settles, the slot comes back — the hold
    // is until-settled, not permanent.
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = await h.rpc(callToolRequest(READ_TOOL, {}, 32), { token: KEY_TOKEN });
    assert.equal(
      callResultText(third.payload),
      'eventually',
      'the slot must be returned once the abandoned work settles',
    );
  });

  it('refuses a call once the concurrency ceiling is reached', async (t) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await start(
      baseOptions({
        maxConcurrentCalls: 1,
        toolTimeoutMs: 5_000,
        dispatchers: {
          sales: fakeDispatcher([
            {
              name: READ_TOOL,
              handle: async () => {
                await gate;
                return { content: 'slow' };
              },
            },
          ]),
        },
      }),
      t,
    );
    if (!h) return;

    const first = h.rpc(callToolRequest(READ_TOOL, {}, 20), { token: KEY_TOKEN });
    // Give the first call time to occupy the single slot.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await h.rpc(callToolRequest(READ_TOOL, {}, 21), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(second.payload) ?? '', /at capacity/);

    release?.();
    assert.equal(callResultText((await first).payload), 'slow');

    // The slot is released, so a later call succeeds — the ceiling is a gate,
    // not a permanent lockout.
    const third = await h.rpc(callToolRequest(READ_TOOL, {}, 22), { token: KEY_TOKEN });
    assert.equal(callResultText(third.payload), 'slow');
  });

  // ── the privacy gate (fail-closed) ───────────────────────────────────────
  // Real PII assertions live in `publicMcpPrivacy.e2e.test.ts`, against the REAL
  // `ToolDispatchService`. This one covers the coarsest gate only: no privacy
  // provider installed at all.

  it('refuses tool calls when no privacy provider is installed, but still lists tools', async (t) => {
    const seen: { name: string; input: unknown }[] = [];
    const h = await start(
      baseOptions({
        allowWithoutPrivacyMasking: false,
        dispatchers: { sales: fakeDispatcher([{ name: READ_TOOL }, { name: WRITE_TOOL }], seen) },
      }),
      t,
    );
    if (!h) return;
    assert.deepEqual(
      toolNames((await h.rpc(listToolsRequest(), { token: KEY_TOKEN })).payload),
      SORTED_TOOLS,
    );
    const { payload } = await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /no privacy provider is installed/);
    assert.deepEqual(seen, [], 'nothing may be dispatched without masking available');
  });

  it('installs a privacy handle on the dispatcher for every call', async (t) => {
    const installed = { value: false };
    const h = await start(
      baseOptions({
        privacyService: maskingPrivacyService(),
        allowWithoutPrivacyMasking: false,
        dispatchers: { sales: fakeDispatcher([{ name: READ_TOOL }], undefined, installed) },
      }),
      t,
    );
    if (!h) return;
    await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.equal(installed.value, true, 'the endpoint must supply a privacy handle explicitly');
  });

  // ── audit ─────────────────────────────────────────────────────────────────

  it('records one audit row per call with the acting identity', async (t) => {
    const audit: PublicMcpAuditEntry[] = [];
    const h = await start(baseOptions({ audit }), t);
    if (!h) return;
    await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.toolName, READ_TOOL);
    assert.equal(audit[0]?.agentId, 'sales');
    assert.equal(audit[0]?.ok, true);
    assert.equal(audit[0]?.write, false);
    assert.equal(audit[0]?.actingIdentity, `apikey:${KEY_ID}`);
  });

  // A timeout is an `McpError` minted inside `withTimeout`, which records
  // nothing. The catch used to treat "is an McpError" as "already audited", so
  // a timed-out call left NO row — the worst case being a write whose external
  // mutation committed while the response hung: the caller gets a timeout, the
  // work may finish later, and nothing anywhere records that it was attempted.
  it('records an audit row for a call that times out', async (t) => {
    const audit: PublicMcpAuditEntry[] = [];
    const h = await start(
      baseOptions({
        audit,
        toolTimeoutMs: 60,
        dispatchers: {
          sales: fakeDispatcher([
            { name: READ_TOOL, handle: () => new Promise(() => {/* never settles */}) },
          ]),
        },
      }),
      t,
    );
    if (!h) return;

    const { payload } = await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.match(rpcErrorMessage(payload) ?? '', /exceeded the 60ms public MCP timeout/);
    assert.equal(audit.length, 1, 'a timed-out call produced no audit row');
    assert.equal(audit[0]?.ok, false);
    assert.match(audit[0]?.error ?? '', /timeout/i);
  });

  it('records exactly ONE row for a masking refusal, not zero and not two', async (t) => {
    // The masking assertion now throws from inside `dispatch` (so a bad body is
    // never cached), which moved it out of reach of the explicit record that
    // used to sit beside the check. The audit flag is what keeps it at one.
    const audit: PublicMcpAuditEntry[] = [];
    const h = await start(
      baseOptions({
        audit,
        allowWithoutPrivacyMasking: false,
        privacyService: undefined,
      }),
      t,
    );
    if (!h) return;

    await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.equal(audit.length, 1, `expected exactly one row, got ${String(audit.length)}`);
    assert.equal(audit[0]?.ok, false);
  });

  it('records a REFUSED call too — a refusal with no trace is uninvestigable', async (t) => {
    const audit: PublicMcpAuditEntry[] = [];
    const h = await start(
      baseOptions({
        audit,
        keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] }],
      }),
      t,
    );
    if (!h) return;
    await h.rpc(callToolRequest(WRITE_TOOL), { token: KEY_TOKEN });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.ok, false);
    assert.equal(audit[0]?.error, 'not allowlisted');
    assert.equal(audit[0]?.write, true, 'the attempt was against a write tool');
    assert.equal(audit[0]?.actingIdentity, `apikey:${KEY_ID}`);
  });

  it('marks a write call as a write in the audit row', async (t) => {
    const audit: PublicMcpAuditEntry[] = [];
    const h = await start(baseOptions({ audit }), t);
    if (!h) return;
    await h.rpc(callToolRequest(WRITE_TOOL), { token: KEY_TOKEN });
    assert.equal(audit[0]?.write, true);
    assert.equal(audit[0]?.ok, true);
  });

  it('does not audit tools/list — only tool calls', async (t) => {
    const audit: PublicMcpAuditEntry[] = [];
    const h = await start(baseOptions({ audit }), t);
    if (!h) return;
    await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    assert.deepEqual(audit, []);
  });

  it('mounts at the shared PUBLIC_MCP_PATH constant', async (t) => {
    const h = await start(baseOptions(), t);
    if (!h) return;
    assert.equal(h.mounted, true);
    assert.ok(h.url.endsWith(PUBLIC_MCP_PATH));
  });
});
