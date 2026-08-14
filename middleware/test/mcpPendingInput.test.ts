/**
 * Issue #544 (W2-1) — MRTR `resultType: "input_required"` mid-call user input.
 *
 * Four things are locked down here:
 *
 *  1. The store. TTL, single-use `take`, and — the security-relevant one —
 *     that the `{userId, sessionId, correlationId}` triple actually isolates:
 *     a lookup differing in ANY component must miss. `sessionScope` alone is a
 *     known-unsafe key (`resolveScope` returns the literal `'http-default'`,
 *     the live cross-user hole from #445).
 *  2. `parseMcpInputRequests` — a malformed `inputRequests` must degrade to a
 *     plain tool error, never to a half-rendered card.
 *  3. `McpManager.callTool` over a REAL MCP connection: an `input_required`
 *     result parks the call, returns a sentinel, consumes no retry attempt, and
 *     audits as neither success nor failure.
 *  4. The full two-turn round trip, including `inputResponses` reaching the
 *     server verbatim and a second `input_required` on replay being capped.
 *
 * Several tests are explicitly labelled MUTATION CHECK: each was verified by
 * breaking the implementation, rebuilding, and confirming this assertion (not
 * an invocation count) turns red. See the PR body for the log.
 */

import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  InMemoryPendingMcpInputStore,
  claimMcpInputFromResults,
  MCP_INPUT_REPLY_PREFIX,
  MCP_INPUT_REQUEST_MAX_FIELDS,
  MCP_INPUT_REQUIRED_SENTINEL_PREFIX,
  McpManager,
  formatMcpInputReply,
  isInputRequiredResult,
  mcpInputRequiredSentinel,
  parseMcpInputSentinel,
  parseMcpInputReply,
  parseMcpInputRequests,
  turnContext,
  type McpCallLogEntry,
  type McpServerConfig,
  type McpSidecarPayload,
  type PendingMcpInput,
} from '@omadia/orchestrator';

// ── fixtures ────────────────────────────────────────────────────────────────

function record(over?: Partial<PendingMcpInput>): PendingMcpInput {
  return {
    correlationId: 'corr-1',
    serverId: 'srv-1',
    serverName: 'Kunden-CRM',
    toolName: 'create_ticket',
    originalArgs: { subject: 'Drucker kaputt' },
    inputRequests: [{ name: 'customerNumber', required: true }],
    replayDepth: 0,
    ...over,
  };
}

const KEY = { userId: 'u1', sessionId: 's1', correlationId: 'corr-1' } as const;

// ── 1. the store ────────────────────────────────────────────────────────────

const OWNER = { userId: 'u1', sessionId: 's1' } as const;

describe('InMemoryPendingMcpInputStore (#544 W2-1)', () => {
  it('round-trips park → claim → take', () => {
    const store = new InMemoryPendingMcpInputStore();
    assert.equal(store.put(record()), 'stored');
    assert.deepEqual(store.claim('corr-1', OWNER), record());
    assert.deepEqual(store.take(KEY), record());
  });

  it('MUTATION CHECK: an UNCLAIMED record is replayable by nobody', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(record());
    // Parked but never claimed: the manager binds no owner, so no `take` can
    // succeed — not even with the right correlation id. Defaulting the owner to
    // the key at park time (or skipping the owner check in `take`) turns this
    // red, and would let a guessed id be redeemed by anyone.
    assert.equal(store.take(KEY), undefined);
    assert.equal(store.take({ userId: null, sessionId: null, correlationId: 'corr-1' }), undefined);
    // …and the failed attempts must not have destroyed it.
    assert.ok(store.claim('corr-1', OWNER));
    assert.ok(store.take(KEY));
  });

  it('take is single-use — a second take of the same key misses', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(record());
    store.claim('corr-1', OWNER);
    assert.ok(store.take(KEY));
    assert.equal(store.take(KEY), undefined);
    assert.equal(store.size(), 0);
  });

  it('MUTATION CHECK: expires a record past the hard TTL', () => {
    let clock = 1_000;
    const store = new InMemoryPendingMcpInputStore({ ttlMs: 5_000, now: () => clock });
    store.put(record());
    store.claim('corr-1', OWNER);
    clock += 4_999;
    assert.ok(store.take(KEY), 'still inside the TTL window');

    store.put(record());
    store.claim('corr-1', OWNER);
    clock += 5_001;
    // The record is UNREACHABLE, not merely flagged. Removing the expiry
    // comparison in `take` turns this red.
    assert.equal(store.take(KEY), undefined);
  });

  it('MUTATION CHECK: an expired record can no longer be claimed either', () => {
    let clock = 0;
    const store = new InMemoryPendingMcpInputStore({ ttlMs: 100, now: () => clock });
    store.put(record());
    clock += 101;
    // Otherwise a card could still be rendered for a call that is long gone.
    assert.equal(store.claim('corr-1', OWNER), undefined);
  });

  it('drops expired records from the map rather than leaking them', () => {
    let clock = 0;
    const store = new InMemoryPendingMcpInputStore({ ttlMs: 100, now: () => clock });
    store.put(record({ correlationId: 'a' }));
    store.put(record({ correlationId: 'b' }));
    assert.equal(store.size(), 2);
    clock += 101;
    assert.equal(store.size(), 0);
  });

  // ── the security requirement ─────────────────────────────────────────────
  it('MUTATION CHECK: cross-SESSION isolation — same user + same correlationId, different session, misses', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(record({ correlationId: 'c' }));
    // `'http-default'` is precisely the literal `resolveScope` hands back for
    // unscoped HTTP turns, so this pair is the #445 shape.
    store.claim('c', { userId: 'u1', sessionId: 'http-default' });
    assert.equal(
      store.take({ userId: 'u1', sessionId: 'other-session', correlationId: 'c' }),
      undefined,
    );
    // …and the record is still there for its rightful owner, i.e. the miss was
    // a miss, not a silent consume.
    assert.ok(store.take({ userId: 'u1', sessionId: 'http-default', correlationId: 'c' }));
  });

  it('MUTATION CHECK: cross-USER isolation — same session + same correlationId, different user, misses', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(record({ correlationId: 'c' }));
    store.claim('c', { userId: 'victim', sessionId: 'http-default' });
    // The #445 hole in one line: sharing `sessionScope` must NOT be enough.
    assert.equal(
      store.take({ userId: 'attacker', sessionId: 'http-default', correlationId: 'c' }),
      undefined,
    );
    assert.ok(store.take({ userId: 'victim', sessionId: 'http-default', correlationId: 'c' }));
  });

  it('null identity is distinct from the string "null"', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(record({ correlationId: 'c' }));
    store.claim('c', { userId: null, sessionId: null });
    assert.equal(store.take({ userId: 'null', sessionId: 'null', correlationId: 'c' }), undefined);
    assert.ok(store.take({ userId: null, sessionId: null, correlationId: 'c' }));
  });

  it('a delimiter inside a component cannot forge another owner', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(record({ correlationId: 'c' }));
    store.claim('c', { userId: 'a', sessionId: 'b' });
    assert.equal(store.take({ userId: 'a","b', sessionId: '', correlationId: 'c' }), undefined);
    assert.equal(store.take({ userId: 'a', sessionId: 'b","c', correlationId: 'c' }), undefined);
    assert.ok(store.take({ userId: 'a', sessionId: 'b', correlationId: 'c' }));
  });

  // ── claim semantics ──────────────────────────────────────────────────────
  it('MUTATION CHECK: claim does NOT consume the replayable record', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(record());
    assert.ok(store.claim('corr-1', OWNER), 'the drain sees the card');
    // THE invariant: the replay happens in a LATER turn, so claiming must leave
    // the record intact. Making `claim` delete the entry (the obvious
    // "symmetry" refactor) turns this red — and would make every replay fail.
    assert.deepEqual(store.take(KEY), record());
  });

  it('MUTATION CHECK: claim is single-shot — the FIRST claimant wins', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(record());
    assert.ok(store.claim('corr-1', OWNER));
    // A second claim — a re-scan, a replayed sentinel, or another turn — misses.
    // Without this a leaked sentinel string could re-bind the record to a
    // different owner, which is the cross-user hole in a different costume.
    assert.equal(store.claim('corr-1', { userId: 'u2', sessionId: 's2' }), undefined);
    // Ownership stayed with the first claimant.
    assert.equal(store.take({ userId: 'u2', sessionId: 's2', correlationId: 'corr-1' }), undefined);
    assert.ok(store.take(KEY));
  });

  it('claiming an unknown correlationId is a miss, not a throw', () => {
    const store = new InMemoryPendingMcpInputStore();
    assert.equal(store.claim('never-parked', OWNER), undefined);
  });

  it('drop discards a record outright', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(record());
    store.drop('corr-1');
    assert.equal(store.size(), 0);
    assert.equal(store.claim('corr-1', OWNER), undefined);
  });

  it('refuses to park a card raised by a replay (bounce cap)', () => {
    const store = new InMemoryPendingMcpInputStore();
    assert.equal(store.put(record({ replayDepth: 1 })), 'replay_capped');
    assert.equal(store.claim('corr-1', OWNER), undefined);
    assert.equal(store.size(), 0);
  });

  it('evicts oldest-first past the entry cap', () => {
    const store = new InMemoryPendingMcpInputStore({ maxEntries: 2 });
    for (const id of ['a', 'b', 'c']) store.put(record({ correlationId: id }));
    assert.equal(store.size(), 2);
    assert.equal(store.claim('a', OWNER), undefined);
    assert.ok(store.claim('c', OWNER));
  });
});

// ── 1b. claimMcpInputFromResults ────────────────────────────────────────────

describe('claimMcpInputFromResults (#544 W2-1)', () => {
  const sentinel = (id: string): string =>
    mcpInputRequiredSentinel(record({ correlationId: id }));

  it('MUTATION CHECK: claims the FIRST sentinel and drops the rest', () => {
    const store = new InMemoryPendingMcpInputStore();
    for (const id of ['a', 'b', 'c']) store.put(record({ correlationId: id }));
    const claimed = claimMcpInputFromResults(
      store,
      [sentinel('a'), 'ordinary result', sentinel('b'), sentinel('c')],
      OWNER,
    );
    assert.equal(claimed?.correlationId, 'a');
    // The losers must not linger: an orphan would be a card nobody renders,
    // holding a parked server call until its TTL. Removing the `drop` leaves
    // size at 3 and turns this red.
    assert.equal(store.size(), 1);
    assert.ok(store.take({ ...OWNER, correlationId: 'a' }));
  });

  it('MUTATION CHECK: a sentinel echoed INSIDE a result cannot forge a card', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(record({ correlationId: 'a' }));
    // The sentinel is the WHOLE string the manager returns, so a hostile server
    // that embeds the marker in its own prose must not be able to raise a card.
    // Switching the parser to `includes` turns this red.
    const claimed = claimMcpInputFromResults(
      store,
      [`Hier ist mein Output. ${sentinel('a')}`],
      OWNER,
    );
    assert.equal(claimed, undefined);
    assert.equal(store.size(), 1, 'and it must not have been dropped either');
  });

  it('returns undefined for a batch with no sentinel at all', () => {
    const store = new InMemoryPendingMcpInputStore();
    assert.equal(
      claimMcpInputFromResults(store, ['just text', '{"ok":true}', ''], OWNER),
      undefined,
    );
  });

  it('parseMcpInputSentinel round-trips and rejects near-misses', () => {
    assert.equal(parseMcpInputSentinel(sentinel('abc')), 'abc');
    for (const bad of [
      'ordinary result',
      '',
      '[mcp_input_required]',
      '[mcp_input_required:',
      '[mcp_input_required:] rest',
      '[mcp_input_required:   ] rest',
    ]) {
      assert.equal(parseMcpInputSentinel(bad), undefined, `parsed: ${bad}`);
    }
  });
});

// ── 2. parseMcpInputRequests ────────────────────────────────────────────────

describe('parseMcpInputRequests (#544 W2-1)', () => {
  it('accepts a well-formed list', () => {
    const out = parseMcpInputRequests([
      { name: 'customerNumber', label: 'Kundennummer', description: 'K-1234' },
    ]);
    assert.equal(out.ok, true);
    assert.deepEqual(out.ok ? out.fields : undefined, [
      {
        name: 'customerNumber',
        label: 'Kundennummer',
        description: 'K-1234',
        required: true,
      },
    ]);
  });

  it('accepts name / id / key and label / title aliases', () => {
    for (const [key, alias] of [
      ['name', 'a'],
      ['id', 'b'],
      ['key', 'c'],
    ] as const) {
      const out = parseMcpInputRequests([{ [key]: alias }]);
      assert.equal(out.ok && out.fields[0]?.name, alias);
    }
    const titled = parseMcpInputRequests([{ name: 'x', title: 'Titel' }]);
    assert.equal(titled.ok && titled.fields[0]?.label, 'Titel');
  });

  it('treats a field as required unless it says otherwise', () => {
    const implicit = parseMcpInputRequests([{ name: 'x' }]);
    assert.equal(implicit.ok && implicit.fields[0]?.required, true);
    const explicit = parseMcpInputRequests([{ name: 'x', required: false }]);
    assert.equal(explicit.ok && explicit.fields[0]?.required, undefined);
  });

  it('marks secret / sensitive fields', () => {
    for (const flag of ['secret', 'sensitive'] as const) {
      const out = parseMcpInputRequests([{ name: 'pin', [flag]: true }]);
      assert.equal(out.ok && out.fields[0]?.secret, true);
    }
  });

  it('MUTATION CHECK: rejects every malformed shape with a distinguishable reason', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ not: 'an array' }, 'not_an_array'],
      ['a string', 'not_an_array'],
      [null, 'not_an_array'],
      [undefined, 'not_an_array'],
      [42, 'not_an_array'],
      [[], 'empty'],
      [Array.from({ length: MCP_INPUT_REQUEST_MAX_FIELDS + 1 }, (_, i) => ({ name: `f${String(i)}` })), 'too_many_fields'],
      [[{ label: 'no name at all' }], 'field_without_name'],
      [[{ name: '   ' }], 'field_without_name'],
      [[{ name: 42 }], 'field_without_name'],
      [['just a string'], 'field_without_name'],
      [[null], 'field_without_name'],
      [[{ name: 'dup' }, { name: 'dup' }], 'duplicate_field_name'],
    ];
    for (const [input, reason] of cases) {
      const out = parseMcpInputRequests(input);
      // Asserting the REASON, not just `ok === false`: a parser that collapsed
      // every failure into one code would still pass an `ok`-only assertion
      // while making the model-facing error string useless.
      assert.equal(out.ok, false, `expected ${JSON.stringify(input)} to be rejected`);
      assert.equal(out.ok === false ? out.reason : undefined, reason);
    }
  });

  it('truncates over-long strings instead of rejecting the field', () => {
    const out = parseMcpInputRequests([{ name: 'x'.repeat(500), description: 'y'.repeat(5_000) }]);
    assert.equal(out.ok, true);
    assert.ok(out.ok && out.fields[0]!.name.length <= 64);
    assert.ok(out.ok && (out.fields[0]!.description?.length ?? 0) <= 500);
  });
});

// ── 3. the reply envelope ───────────────────────────────────────────────────

describe('mcp input reply envelope (#544 W2-1)', () => {
  it('round-trips', () => {
    const wire = formatMcpInputReply({
      correlationId: 'corr-9',
      inputResponses: { customerNumber: 'K-1234' },
    });
    assert.ok(wire.startsWith(MCP_INPUT_REPLY_PREFIX));
    assert.deepEqual(parseMcpInputReply(wire), {
      correlationId: 'corr-9',
      inputResponses: { customerNumber: 'K-1234' },
    });
  });

  it('MUTATION CHECK: an ordinary user message is never mistaken for an envelope', () => {
    for (const plain of [
      'Wie ist das Wetter?',
      '',
      '   ',
      // Deliberately adversarial: the literal prefix typed by a human, and the
      // prefix with junk. Both must yield a NORMAL turn — a parser that threw,
      // or that returned a truthy record with an empty correlationId, would
      // hijack the user's message.
      MCP_INPUT_REPLY_PREFIX,
      `${MCP_INPUT_REPLY_PREFIX} not json`,
      `${MCP_INPUT_REPLY_PREFIX} []`,
      `${MCP_INPUT_REPLY_PREFIX} "string"`,
      `${MCP_INPUT_REPLY_PREFIX} {}`,
      `${MCP_INPUT_REPLY_PREFIX} {"correlationId":""}`,
      `${MCP_INPUT_REPLY_PREFIX} {"correlationId":"c"}`,
      `${MCP_INPUT_REPLY_PREFIX} {"correlationId":"c","inputResponses":[]}`,
      `${MCP_INPUT_REPLY_PREFIX} {"correlationId":"c","inputResponses":null}`,
    ]) {
      assert.equal(parseMcpInputReply(plain), undefined, `hijacked: ${plain}`);
    }
  });

  it('drops non-string response values instead of forwarding them', () => {
    const parsed = parseMcpInputReply(
      `${MCP_INPUT_REPLY_PREFIX} {"correlationId":"c","inputResponses":{"a":"ok","b":42,"c":{"nested":1}}}`,
    );
    assert.deepEqual(parsed?.inputResponses, { a: 'ok' });
  });
});

// ── 4. isInputRequiredResult ────────────────────────────────────────────────

describe('SDK 1.29.0 result-schema characterization (#544 W2-1)', () => {
  it('passes unmodelled MRTR keys through, so no SDK bump is required', () => {
    // Captured from the SHIPPED SDK. `CallToolResultSchema` derives from
    // `ResultSchema`, which is `.passthrough()`. If a future SDK tightens that,
    // THIS test goes red first and names the cause — instead of MRTR silently
    // going dead because `resultType` vanished before `callTool` returned.
    const parsed = CallToolResultSchema.parse({
      content: [{ type: 'text', text: 'x' }],
      resultType: 'input_required',
      inputRequests: [{ name: 'a' }],
    }) as Record<string, unknown>;
    assert.equal(parsed['resultType'], 'input_required');
    assert.deepEqual(parsed['inputRequests'], [{ name: 'a' }]);
  });
});

describe('isInputRequiredResult (#544 W2-1)', () => {
  it('matches only an exact non-error input_required result', () => {
    assert.equal(isInputRequiredResult({ resultType: 'input_required' }), true);
    assert.equal(isInputRequiredResult({ resultType: 'input_required', isError: true }), false);
    assert.equal(isInputRequiredResult({ resultType: 'INPUT_REQUIRED' }), false);
    assert.equal(isInputRequiredResult({ resultType: 'text' }), false);
    assert.equal(isInputRequiredResult({}), false);
    assert.equal(isInputRequiredResult(null), false);
    assert.equal(isInputRequiredResult('input_required'), false);
  });
});

// ── 5. integration: a real fake MCP server that asks for input ──────────────

interface FakeServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

/** Per-tool call counter, so "did the manager retry?" is answered by what the
 *  SERVER saw rather than by counting mock invocations. */
const serverCalls: string[] = [];
/** Arguments the server received, verbatim, for the replay assertion. */
const serverArgs: Array<Record<string, unknown>> = [];
/** Flipped by a test to make `ask_twice` keep asking. */
let alwaysAsk = false;

const INPUT_REQUESTS = [
  { name: 'customerNumber', label: 'Kundennummer', description: 'z. B. K-1234' },
  { name: 'pin', label: 'PIN', secret: true },
];

function buildMcpServerInstance(): McpSdkServer {
  const mcp = new McpSdkServer(
    { name: 'fake-crm', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'create_ticket', inputSchema: { type: 'object' as const } },
      { name: 'ask_twice', inputSchema: { type: 'object' as const } },
      { name: 'malformed_ask', inputSchema: { type: 'object' as const } },
      { name: 'plain', inputSchema: { type: 'object' as const } },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    serverCalls.push(name);
    serverArgs.push(args);
    if (name === 'plain') {
      return { content: [{ type: 'text' as const, text: 'just text' }] };
    }
    if (name === 'malformed_ask') {
      return {
        content: [{ type: 'text' as const, text: 'need input' }],
        resultType: 'input_required',
        // Off-spec on purpose: an object where the array belongs.
        inputRequests: { customerNumber: 'Kundennummer' },
      } as never;
    }
    const answered = typeof args['inputResponses'] === 'object' && args['inputResponses'] !== null;
    if (answered && !(name === 'ask_twice' && alwaysAsk)) {
      const responses = args['inputResponses'] as Record<string, unknown>;
      // Echo the collected values back so the test can prove they arrived
      // VERBATIM rather than re-serialized or re-masked somewhere en route.
      return {
        content: [
          {
            type: 'text' as const,
            text: `Ticket angelegt für ${String(responses['customerNumber'])} (pin=${String(responses['pin'])}, subject=${String(args['subject'])})`,
          },
        ],
      };
    }
    return {
      content: [{ type: 'text' as const, text: 'Ich brauche noch Angaben.' }],
      resultType: 'input_required',
      inputRequests: INPUT_REQUESTS,
      message: 'Bitte Kundennummer und PIN angeben.',
    } as never;
  });
  return mcp;
}

async function startFakeMcpServer(): Promise<FakeServerHandle> {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const mcp = buildMcpServerInstance();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await mcp.connect(transport);
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      await transport.handleRequest(req, res, raw.length > 0 ? JSON.parse(raw) : undefined);
      return;
    }
    await transport.handleRequest(req, res);
  };
  const http: HttpServer = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const sockets = new Set<import('node:net').Socket>();
  http.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

const fake = await startFakeMcpServer();
after(() => fake.close());

const CFG: McpServerConfig = {
  id: '00000000-0000-4000-8000-00000000f544',
  name: 'Kunden-CRM',
  transport: 'http',
  endpoint: fake.url,
};

interface Harness {
  readonly store: InMemoryPendingMcpInputStore;
  readonly manager: McpManager;
  readonly audit: McpCallLogEntry[];
  readonly sidecars: McpSidecarPayload[];
}

function harness(): Harness {
  const store = new InMemoryPendingMcpInputStore();
  const audit: McpCallLogEntry[] = [];
  const sidecars: McpSidecarPayload[] = [];
  const manager = new McpManager({
    pendingInput: store,
    onToolCall: (e) => audit.push(e),
    structuredSink: (p) => sidecars.push(p),
  });
  return { store, manager, audit, sidecars };
}

/** Claim a card the way the orchestrator does: from the sentinel string. */
function claimFrom(
  h: Harness,
  sentinel: string,
  owner: { userId: string | null; sessionId: string | null } = OWNER,
): PendingMcpInput | undefined {
  return claimMcpInputFromResults(h.store, [sentinel], owner);
}

/** Run inside a turn so audit attribution has something
 *  to read — exactly the path production takes. */
async function inTurn<T>(
  turnId: string,
  userId: string | undefined,
  sessionScope: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return turnContext.run(
    {
      turnId,
      turnDate: '2026-07-30',
      agentSlug: 'main',
      ...(userId !== undefined ? { userId } : {}),
      ...(sessionScope !== undefined ? { sessionScope } : {}),
    },
    fn,
  );
}

describe('callTool parks an input_required result (#544 W2-1)', () => {
  it('reads resultType + inputRequests off a 2025-era peer over a real wire', async () => {
    // Criterion 1, end to end: both fields survive `tools/call` against the
    // era most peers actually run — `startFakeMcpServer` above is hand-rolled
    // 2025-era JSON-RPC and has never heard of `server/discover`.
    //
    // #562 phase 2 moved `transport: 'http'` (which is what `CFG` is) onto
    // `@modelcontextprotocol/client@2`, so this file now exercises the v2
    // client against a LEGACY-era peer. That combination is the one the port
    // could have broken silently: v2 treats `resultType` as a wire-only
    // discriminator and strips it when it decodes a legacy `tools/call` reply
    // as a complete result, which would leave `isInputRequiredResult` false,
    // the call unparked, and the holding text handed to the model as if it
    // were the answer. `restoreLegacyInputRequired` in `mcpClient.ts` puts the
    // discriminator back; deleting it turns ELEVEN tests in this file red.
    //
    // NOT labelled a mutation check for the schema, deliberately: reverting the
    // `LENIENT_CALL_TOOL_RESULT_SCHEMA` extension leaves this GREEN, because
    // `ResultSchema` is `.passthrough()` (characterized in the test below). The
    // extension makes the dependency explicit and typed rather than possible —
    // see the schema's doc comment. Claiming otherwise here would be a test
    // comment that lies.
    const h = harness();
    const out = await inTurn('t-schema', 'u1', 's1', () =>
      h.manager.callTool(CFG, 'create_ticket', { subject: 'Drucker' }),
    );
    assert.ok(
      out.startsWith(MCP_INPUT_REQUIRED_SENTINEL_PREFIX),
      `resultType/inputRequests were stripped — got: ${out}`,
    );
  });

  it('MUTATION CHECK: the peer this file drives really is 2025-era (#562 phase 2)', async () => {
    // Without this, every assertion above would still pass if the fake server
    // silently became a modern-era peer — and the legacy path, where the
    // discriminator is stripped and has to be restored, would stop being
    // covered at all while the file kept reporting green.
    const h = harness();
    const session = await (
      h.manager as unknown as {
        getOrConnect(
          cfg: McpServerConfig,
          token: string | null,
        ): Promise<{ client: { family: string; era: () => string } }>;
      }
    ).getOrConnect(CFG, null);
    assert.equal(session.client.family, 'v2', 'http connects on the v2 client family');
    assert.equal(session.client.era(), 'legacy', 'this file must cover the 2025 era');
  });

  it('returns a stable sentinel instead of the rendered text', async () => {
    const h = harness();
    const out = await inTurn('t-1', 'u1', 's1', () =>
      h.manager.callTool(CFG, 'create_ticket', { subject: 'Drucker' }),
    );
    assert.ok(out.startsWith(MCP_INPUT_REQUIRED_SENTINEL_PREFIX));
    assert.equal(typeof out, 'string');
    // Names the fields so the model can see what is being collected…
    assert.ok(out.includes('customerNumber'));
    // …and tells it not to re-call (the model-confusion guard's prose half).
    assert.ok(/nicht erneut/i.test(out));
  });

  it('parks a record reachable only by the full triple', async () => {
    const h = harness();
    const sentinel = await inTurn('t-2', 'u1', 's1', () =>
      h.manager.callTool(CFG, 'create_ticket', { subject: 'X' }),
    );
    const pending = claimFrom(h, sentinel);
    assert.ok(pending);
    assert.equal(pending.serverId, CFG.id);
    assert.equal(pending.serverName, 'Kunden-CRM');
    assert.equal(pending.toolName, 'create_ticket');
    assert.deepEqual(pending.originalArgs, { subject: 'X' });
    assert.equal(pending.replayDepth, 0);
    assert.equal(pending.prompt, 'Bitte Kundennummer und PIN angeben.');
    assert.deepEqual(
      pending.inputRequests.map((f) => f.name),
      ['customerNumber', 'pin'],
    );
    assert.equal(pending.inputRequests[1]?.secret, true);
    // The triple binds it to this caller.
    const cid = pending.correlationId;
    assert.equal(h.store.take({ userId: 'u1', sessionId: 'other', correlationId: cid }), undefined);
    assert.ok(h.store.take({ userId: 'u1', sessionId: 's1', correlationId: cid }));
  });

  it('MUTATION CHECK: audits exactly one row that is neither a success nor a failure', async () => {
    const h = harness();
    await inTurn('t-3', 'u1', 's1', () => h.manager.callTool(CFG, 'create_ticket', {}));
    assert.equal(h.audit.length, 1);
    const row = h.audit[0]!;
    // `ok === true` alone would let this pass while the row still LIED about a
    // delivered result; `outcome` is the assertion that catches that. Making
    // `parkInputRequired` emit `'ok'` or `'fail'` turns this red.
    assert.equal(row.outcome, 'input_required');
    assert.equal(row.ok, true, 'a parked call must not pollute failure-rate queries');
    assert.equal(row.error, null);
    assert.equal(row.toolName, 'create_ticket');
    assert.equal(row.serverName, 'Kunden-CRM');
  });

  it('MUTATION CHECK: consumes no retry attempt — the server sees exactly one call', async () => {
    const h = harness();
    serverCalls.length = 0;
    await inTurn('t-4', 'u1', 's1', () => h.manager.callTool(CFG, 'create_ticket', {}));
    // Observed at the SERVER, not by counting a mock: routing the park through
    // `handleFailure` (or falling through to `continue`) makes the transient
    // retry fire and turns this into 2.
    assert.deepEqual(serverCalls, ['create_ticket']);
  });

  it('emits an input_required sidecar carrying the server attribution', async () => {
    const h = harness();
    await inTurn('t-5', 'u1', 's1', () => h.manager.callTool(CFG, 'create_ticket', {}));
    assert.equal(h.sidecars.length, 1);
    const payload = h.sidecars[0]!;
    assert.equal(payload.kind, 'input_required');
    if (payload.kind !== 'input_required') return;
    assert.equal(payload.turnId, 't-5');
    // Mandatory: the card must be able to say WHO is asking for free text.
    assert.equal(payload.pending.serverName, 'Kunden-CRM');
    assert.equal(payload.pending.serverId, CFG.id);
  });

  it('leaves an ordinary success completely unchanged', async () => {
    const h = harness();
    const out = await inTurn('t-6', 'u1', 's1', () => h.manager.callTool(CFG, 'plain', {}));
    assert.equal(out, 'just text');
    assert.equal(h.audit[0]?.outcome, 'ok');
    assert.equal(h.audit[0]?.ok, true);
    assert.equal(h.store.size(), 0);
    assert.equal(h.sidecars.length, 0);
  });

  it('MUTATION CHECK: malformed inputRequests degrade to a plain error string', async () => {
    const h = harness();
    const out = await inTurn('t-7', 'u1', 's1', () =>
      h.manager.callTool(CFG, 'malformed_ask', {}),
    );
    // A plain tool error — NOT a sentinel, NOT a half-built card.
    assert.ok(out.startsWith('Error:'), out);
    assert.ok(!out.startsWith(MCP_INPUT_REQUIRED_SENTINEL_PREFIX));
    assert.ok(out.includes('not_an_array'));
    assert.equal(h.store.size(), 0, 'nothing may be parked');
    assert.equal(claimFrom(h, out), undefined, 'no card may be claimable');
    assert.equal(h.sidecars.length, 0);
    // This one IS a failure and must audit as such.
    assert.equal(h.audit[0]?.outcome, 'fail');
    assert.equal(h.audit[0]?.ok, false);
  });

  it('degrades to a plain error when no store is wired', async () => {
    const audit: McpCallLogEntry[] = [];
    const manager = new McpManager({ onToolCall: (e) => audit.push(e) });
    const out = await inTurn('t-8', 'u1', 's1', () =>
      manager.callTool(CFG, 'create_ticket', {}),
    );
    assert.ok(out.startsWith('Error:'), out);
    assert.ok(out.includes('not enabled on this deployment'));
    assert.equal(audit[0]?.outcome, 'fail');
  });

  it('MUTATION CHECK: a second input_required in one turn does not raise a second card', async () => {
    const h = harness();
    const first = await inTurn('t-9', 'u1', 's1', () =>
      h.manager.callTool(CFG, 'create_ticket', { n: 1 }),
    );
    const second = await inTurn('t-9', 'u1', 's1', () =>
      h.manager.callTool(CFG, 'create_ticket', { n: 2 }),
    );
    assert.ok(first.startsWith(MCP_INPUT_REQUIRED_SENTINEL_PREFIX));
    assert.ok(second.startsWith(MCP_INPUT_REQUIRED_SENTINEL_PREFIX));
    assert.equal(h.sidecars.length, 2, 'each parked call gets its own sidecar');
    // First-call-wins is enforced where the card is CHOSEN, not where it is
    // parked — verified through the payload rather than a counter: the claimed
    // record belongs to call #1, and #2 is dropped rather than left orphaned.
    const claimed = claimMcpInputFromResults(h.store, [first, second], OWNER);
    assert.deepEqual(claimed?.originalArgs, { n: 1 });
    assert.equal(h.store.size(), 1);
  });
});

describe('two-turn round trip (#544 W2-1)', () => {
  it('MUTATION CHECK: inputResponses reach the server verbatim alongside the original args', async () => {
    const h = harness();
    serverArgs.length = 0;

    // ── turn 1: the model calls the tool, the server asks for input.
    const sentinel = await inTurn('turn-A', 'u1', 'sess-1', () =>
      h.manager.callTool(CFG, 'create_ticket', { subject: 'Drucker kaputt' }),
    );
    assert.ok(sentinel.startsWith(MCP_INPUT_REQUIRED_SENTINEL_PREFIX));
    const card = claimFrom(h, sentinel, { userId: 'u1', sessionId: 'sess-1' });
    assert.ok(card);

    // ── the user fills the card in; the channel submits the envelope.
    const reply = parseMcpInputReply(
      formatMcpInputReply({
        correlationId: card.correlationId,
        inputResponses: { customerNumber: 'K-1234', pin: '9876' },
      }),
    );
    assert.ok(reply);

    // ── turn 2: a DIFFERENT turn resolves the correlation id and replays.
    const taken = h.store.take({
      userId: 'u1',
      sessionId: 'sess-1',
      correlationId: reply.correlationId,
    });
    assert.ok(taken);
    const out = await inTurn('turn-B', 'u1', 'sess-1', () =>
      h.manager.callTool(CFG, taken.toolName, {
        ...taken.originalArgs,
        inputResponses: reply.inputResponses,
      }),
    );

    // Asserting the SERVER's view of the arguments, not our own call site: the
    // original args survive AND the collected values arrive unmangled. Any
    // re-serialization, masking or key-renaming en route turns this red.
    const lastArgs = serverArgs.at(-1)!;
    assert.deepEqual(lastArgs, {
      subject: 'Drucker kaputt',
      inputResponses: { customerNumber: 'K-1234', pin: '9876' },
    });
    assert.equal(out, 'Ticket angelegt für K-1234 (pin=9876, subject=Drucker kaputt)');
    assert.equal(h.audit.at(-1)?.outcome, 'ok');
    // Single-use: the correlation id is spent.
    assert.equal(
      h.store.take({ userId: 'u1', sessionId: 'sess-1', correlationId: reply.correlationId }),
      undefined,
    );
  });

  it('MUTATION CHECK: a second input_required on replay is capped, not parked again', async () => {
    const h = harness();
    alwaysAsk = true;
    try {
      const out = await inTurn('turn-C', 'u1', 'sess-1', () =>
        h.manager.callTool(CFG, 'ask_twice', {
          subject: 'X',
          inputResponses: { customerNumber: 'K-1' },
        }),
      );
      // The ping-pong stops HERE with an error, rather than raising card #2.
      // Removing the `replayDepth` derivation (or the store's cap) parks a new
      // record and turns this red.
      assert.ok(out.startsWith('Error:'), out);
      assert.ok(/asked for user input again/.test(out));
      assert.equal(h.store.size(), 0);
      assert.equal(claimFrom(h, out), undefined);
      assert.equal(h.sidecars.length, 0);
      assert.equal(h.audit.at(-1)?.outcome, 'fail');
    } finally {
      alwaysAsk = false;
    }
  });

  it('a record whose TTL lapsed is simply gone — the replay cannot resurrect it', async () => {
    let clock = 0;
    const store = new InMemoryPendingMcpInputStore({ ttlMs: 1_000, now: () => clock });
    const manager = new McpManager({ pendingInput: store });
    const sentinel = await inTurn('turn-D', 'u1', 'sess-1', () =>
      manager.callTool(CFG, 'create_ticket', {}),
    );
    const card = claimMcpInputFromResults(store, [sentinel], {
      userId: 'u1',
      sessionId: 'sess-1',
    });
    assert.ok(card);
    clock += 1_001;
    assert.equal(
      store.take({ userId: 'u1', sessionId: 'sess-1', correlationId: card.correlationId }),
      undefined,
    );
  });
});
