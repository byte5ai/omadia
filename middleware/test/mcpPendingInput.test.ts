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
  MCP_INPUT_ALREADY_PENDING_SENTINEL,
  MCP_INPUT_REPLY_PREFIX,
  MCP_INPUT_REQUEST_MAX_FIELDS,
  MCP_INPUT_REQUIRED_SENTINEL_PREFIX,
  McpManager,
  formatMcpInputReply,
  isInputRequiredResult,
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

describe('InMemoryPendingMcpInputStore (#544 W2-1)', () => {
  it('round-trips a parked record', () => {
    const store = new InMemoryPendingMcpInputStore();
    assert.equal(store.put(KEY, record(), 'turn-1'), 'stored');
    assert.deepEqual(store.take(KEY), record());
  });

  it('take is single-use — a second take of the same key misses', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(KEY, record(), 'turn-1');
    assert.ok(store.take(KEY));
    assert.equal(store.take(KEY), undefined);
    assert.equal(store.size(), 0);
  });

  it('MUTATION CHECK: expires a record past the hard TTL', () => {
    let clock = 1_000;
    const store = new InMemoryPendingMcpInputStore({
      ttlMs: 5_000,
      now: () => clock,
    });
    store.put(KEY, record(), 'turn-1');
    clock += 4_999;
    assert.ok(store.take(KEY), 'still inside the TTL window');

    store.put(KEY, record(), 'turn-2');
    clock += 5_001;
    // The assertion that matters: the record is UNREACHABLE, not merely
    // flagged. Removing the expiry comparison in `take` turns this red.
    assert.equal(store.take(KEY), undefined);
  });

  it('drops expired records from the map rather than leaking them', () => {
    let clock = 0;
    const store = new InMemoryPendingMcpInputStore({ ttlMs: 100, now: () => clock });
    store.put({ ...KEY, correlationId: 'a' }, record({ correlationId: 'a' }), 't1');
    store.put({ ...KEY, correlationId: 'b' }, record({ correlationId: 'b' }), 't2');
    assert.equal(store.size(), 2);
    clock += 101;
    assert.equal(store.size(), 0);
  });

  // ── the security requirement ─────────────────────────────────────────────
  it('MUTATION CHECK: cross-SESSION isolation — same user + same correlationId, different session, misses', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put({ userId: 'u1', sessionId: 'http-default', correlationId: 'c' }, record(), 't1');
    // `'http-default'` is precisely the literal `resolveScope` hands back for
    // unscoped HTTP turns, so this pair is the #445 shape.
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
    store.put({ userId: 'victim', sessionId: 'http-default', correlationId: 'c' }, record(), 't1');
    // The #445 hole in one line: sharing `sessionScope` must NOT be enough.
    assert.equal(
      store.take({ userId: 'attacker', sessionId: 'http-default', correlationId: 'c' }),
      undefined,
    );
    assert.ok(store.take({ userId: 'victim', sessionId: 'http-default', correlationId: 'c' }));
  });

  it('a correlationId alone is not a key', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(KEY, record(), 't1');
    assert.equal(store.take({ userId: null, sessionId: null, correlationId: 'corr-1' }), undefined);
  });

  it('null identity is distinct from the string "null"', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put({ userId: null, sessionId: null, correlationId: 'c' }, record(), 't1');
    assert.equal(
      store.take({ userId: 'null', sessionId: 'null', correlationId: 'c' }),
      undefined,
    );
  });

  it('a delimiter inside a component cannot forge another key', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put({ userId: 'a', sessionId: 'b', correlationId: 'c' }, record(), 't1');
    for (const forged of [
      { userId: 'a', sessionId: 'b', correlationId: 'c' as string },
      { userId: 'a","b', sessionId: 'c', correlationId: 'c' },
      { userId: 'a', sessionId: 'b","c', correlationId: 'c' },
    ]) {
      const hit = store.take(forged);
      if (forged.userId === 'a' && forged.sessionId === 'b') {
        assert.ok(hit, 'the real key must still hit');
      } else {
        assert.equal(hit, undefined, `forged key ${JSON.stringify(forged)} hit`);
      }
    }
  });

  // ── turn-slot semantics ──────────────────────────────────────────────────
  it('MUTATION CHECK: takePending does NOT consume the replayable record', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(KEY, record(), 'turn-1');
    assert.ok(store.takePending('turn-1'), 'the turn drain sees the card');
    // THE invariant: the replay happens in a LATER turn, so draining the turn
    // slot must leave the keyed record intact. Making `takePending` delete the
    // entry (the obvious "symmetry" refactor) turns this red — and would make
    // every replay silently fail with "expired".
    assert.deepEqual(store.take(KEY), record());
  });

  it('takePending is idempotent within a turn', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(KEY, record(), 'turn-1');
    assert.ok(store.takePending('turn-1'));
    assert.equal(store.takePending('turn-1'), undefined);
  });

  it('MUTATION CHECK: takePending is turn-scoped — another concurrent turn sees nothing', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(KEY, record(), 'turn-alice');
    // Two users' turns run concurrently in one process. Bob's turn must not
    // pick up Alice's card. Keying the pending slot on anything process-global
    // (a single instance field, as `askUserChoiceTool` can afford because it is
    // per-orchestrator) turns this red.
    assert.equal(store.takePending('turn-bob'), undefined);
    assert.ok(store.takePending('turn-alice'));
  });

  it('takePending outside a turn is a no-op', () => {
    const store = new InMemoryPendingMcpInputStore();
    store.put(KEY, record(), null);
    assert.equal(store.takePending(null), undefined);
    assert.equal(store.takePending(''), undefined);
    // Still replayable by key — parking worked, only the turn drain is absent.
    assert.ok(store.take(KEY));
  });

  it('first-write-wins per turn', () => {
    const store = new InMemoryPendingMcpInputStore();
    assert.equal(store.put(KEY, record(), 'turn-1'), 'stored');
    const second = { ...KEY, correlationId: 'corr-2' };
    assert.equal(store.put(second, record({ correlationId: 'corr-2' }), 'turn-1'), 'already_pending');
    // The loser was not parked at all — no orphan.
    assert.equal(store.take(second), undefined);
    assert.equal(store.takePending('turn-1')?.correlationId, 'corr-1');
  });

  it('refuses to park a card raised by a replay (bounce cap)', () => {
    const store = new InMemoryPendingMcpInputStore();
    assert.equal(store.put(KEY, record({ replayDepth: 1 }), 'turn-2'), 'replay_capped');
    assert.equal(store.take(KEY), undefined);
    assert.equal(store.size(), 0);
  });

  it('evicts oldest-first past the entry cap', () => {
    const store = new InMemoryPendingMcpInputStore({ maxEntries: 2 });
    for (const id of ['a', 'b', 'c']) {
      store.put({ ...KEY, correlationId: id }, record({ correlationId: id }), `t-${id}`);
    }
    assert.equal(store.size(), 2);
    assert.equal(store.take({ ...KEY, correlationId: 'a' }), undefined);
    assert.ok(store.take({ ...KEY, correlationId: 'c' }));
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

/** Run inside a turn so the manager's default owner resolution has something
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
  it('reads resultType + inputRequests off the shipped SDK 1.29.0 over a real wire', async () => {
    // Criterion 1, end to end: both fields survive `tools/call` on the SDK we
    // actually ship, so MRTR needs no version bump and no v2 family (#540).
    //
    // NOT labelled a mutation check, deliberately: reverting the
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
    await inTurn('t-2', 'u1', 's1', () => h.manager.callTool(CFG, 'create_ticket', { subject: 'X' }));
    const pending = h.store.takePending('t-2');
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
    assert.equal(h.store.takePending('t-7'), undefined, 'no turn must be short-circuited');
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
    assert.equal(second, MCP_INPUT_ALREADY_PENDING_SENTINEL);
    // First-call-wins, verified through the payload rather than a counter: the
    // parked record still belongs to call #1. Dropping the turn-slot guard lets
    // call #2 overwrite it and turns this red.
    assert.equal(h.sidecars.length, 1);
    assert.deepEqual(h.store.takePending('t-9')?.originalArgs, { n: 1 });
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
    const card = h.store.takePending('turn-A');
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
      assert.equal(h.store.takePending('turn-C'), undefined);
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
    await inTurn('turn-D', 'u1', 'sess-1', () => manager.callTool(CFG, 'create_ticket', {}));
    const card = store.takePending('turn-D');
    assert.ok(card);
    clock += 1_001;
    assert.equal(
      store.take({ userId: 'u1', sessionId: 'sess-1', correlationId: card.correlationId }),
      undefined,
    );
  });
});
