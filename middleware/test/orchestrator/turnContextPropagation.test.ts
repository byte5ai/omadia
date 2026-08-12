/**
 * W3-A — `turnContext` must reach tool handlers on BOTH orchestrator entry
 * points.
 *
 * The streaming entry point used to establish the turn scope with
 * `AsyncLocalStorage.enterWith` (`turnContext.enter`). `enterWith` binds the
 * store to the async resource that is executing at that instant; an async
 * generator, however, is resumed in the async context of whoever called
 * `.next()`. So the moment `chatStream` yielded its first event the store was
 * gone, and every tool handler further down ran with `turnContext.current()`
 * either `undefined` or — worse — bound to whatever OUTER scope the consumer
 * happened to be iterating from.
 *
 * That silently broke the MCP audit trail on every streaming turn (which is
 * every web-ui and every channel turn): `callerKind` degraded to
 * `unattributed`, `turnId` to `null`, `callerAgent` to `null`, and the
 * per-user OAuth identity (`mcpUserKey`) was unreachable, so `resolveIdentity`
 * recorded `unresolved`.
 *
 * These tests therefore assert the OBSERVABLE audit row, not just the context
 * object. Tests labelled MUTATION CHECK were verified by breaking the
 * invariant, rebuilding, and confirming the assertion turns red.
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
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  McpManager,
  NativeToolRegistry,
  Orchestrator,
  steeringBus,
  turnContext,
  type McpCallLogEntry,
  type McpServerConfig,
  type TurnContextValue,
} from '@omadia/orchestrator';

import { UNRESOLVED_IDENTITY, auditIdentity } from '../../src/services/mcpDelegation.js';

// ── fake MCP server ─────────────────────────────────────────────────────────

function buildMcpServerInstance(): McpSdkServer {
  const mcp = new McpSdkServer(
    { name: 'fake-crm', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'ping', inputSchema: { type: 'object' as const } }],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));
  return mcp;
}

async function startFakeMcpServer(): Promise<{ url: string; close(): Promise<void> }> {
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
  id: '00000000-0000-4000-8000-0000000003a0',
  name: 'Kunden-CRM',
  transport: 'http',
  endpoint: fake.url,
};

// ── scripted provider ───────────────────────────────────────────────────────

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

function fakeProvider(streams: LlmStreamEvent[][]): LlmProvider {
  let idx = 0;
  const take = (): LlmStreamEvent[] => {
    if (idx >= streams.length) {
      throw new Error(`no scripted stream for provider call ${String(idx + 1)}`);
    }
    const events = streams[idx]!;
    idx += 1;
    return events;
  };
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      const events = take();
      const final = events.at(-1) as { type: string; response: LlmResponse };
      return final.response;
    },
    stream: (): AsyncIterable<LlmStreamEvent> => {
      const events = take();
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function toolCallStream(
  calls: Array<{ id: string; name: string; input: unknown }>,
): LlmStreamEvent[] {
  return [
    {
      type: 'final',
      response: {
        content: calls.map((c) => ({
          type: 'tool_call',
          id: c.id,
          name: c.name,
          input: c.input,
        })),
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        model: 'test',
        usage: { inputTokens: 50, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    } as LlmStreamEvent,
  ];
}

function textStream(text: string): LlmStreamEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'final',
      response: {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'test',
        usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    } as LlmStreamEvent,
  ];
}

const PROBE_TOOL = 'probe_turn_context';
const AGENT_SLUG = 'probe-agent';

/** A snapshot of what a tool handler saw, so assertions read the HANDLER's
 *  view of the turn rather than the test's. */
interface Seen {
  readonly defined: boolean;
  readonly turnId: string | undefined;
  readonly agentSlug: string | undefined;
  readonly userId: string | undefined;
  readonly sessionScope: string | undefined;
  readonly mcpUserKey: string | undefined;
}

function snapshot(ctx: TurnContextValue | undefined): Seen {
  return {
    defined: ctx !== undefined,
    turnId: ctx?.turnId,
    agentSlug: ctx?.agentSlug,
    userId: ctx?.userId,
    sessionScope: ctx?.sessionScope,
    mcpUserKey: ctx?.mcpUserKey,
  };
}

interface Harness {
  readonly orchestrator: Orchestrator;
  /** One entry per `probe_turn_context` dispatch, in dispatch order. */
  readonly seen: Seen[];
  /** Every audit row the McpManager emitted. */
  readonly audit: McpCallLogEntry[];
}

/**
 * @param callMcp  when true the probe handler ALSO makes a real MCP call, so
 *                 the audit row is produced from inside the tool-dispatch
 *                 call tree — exactly where production makes it.
 */
function harness(
  streams: LlmStreamEvent[][],
  opts?: { readonly callMcp?: boolean },
): Harness {
  const seen: Seen[] = [];
  const audit: McpCallLogEntry[] = [];
  const manager = new McpManager({
    onToolCall: (entry) => audit.push(entry),
    auth: {
      // Mirrors the production wiring in `src/index.ts`: the identity is
      // resolved from the TURN CONTEXT, per server delegation mode.
      getToken: async () => null,
      onAuthFailure: async () => null,
      resolveIdentity: async () =>
        auditIdentity({ delegation: 'per_user' }, turnContext.current()?.mcpUserKey),
    },
  });
  const registry = new NativeToolRegistry();
  registry.register(PROBE_TOOL, {
    handler: async () => {
      seen.push(snapshot(turnContext.current()));
      if (opts?.callMcp) return manager.callTool(CFG, 'ping', {});
      return 'ok';
    },
    spec: {
      name: PROBE_TOOL,
      description: 'Records the ambient turn context.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    agentId: 'probe',
  });
  const orchestrator = new Orchestrator({
    provider: fakeProvider(streams),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: registry,
    agentId: AGENT_SLUG,
  });
  return { orchestrator, seen, audit };
}

const oneToolTurn = (): LlmStreamEvent[][] => [
  toolCallStream([{ id: 'tu-1', name: PROBE_TOOL, input: {} }]),
  textStream('fertig'),
];

async function drain(orchestrator: Orchestrator, userId = 'u1'): Promise<void> {
  for await (const _ of orchestrator.chatStream({
    userMessage: 'los',
    sessionScope: 'sess-w3a',
    userId,
  })) {
    // drain
  }
}

// ── 1. the context reaches a tool handler on BOTH paths ─────────────────────

describe('turnContext reaches tool handlers (W3-A)', () => {
  it('MUTATION CHECK: buffered path (runTurn) — handler sees the full turn context', async () => {
    const h = harness(oneToolTurn());
    await h.orchestrator.runTurn({
      userMessage: 'los',
      sessionScope: 'sess-w3a',
      userId: 'u1',
    });
    assert.equal(h.seen.length, 1, 'the probe tool never ran');
    const s = h.seen[0]!;
    assert.equal(s.defined, true, 'turnContext.current() was undefined in the tool handler');
    assert.ok(s.turnId && s.turnId.length > 0, 'no turnId in the tool handler');
    assert.equal(s.agentSlug, AGENT_SLUG);
    assert.equal(s.userId, 'u1');
    assert.equal(s.sessionScope, 'sess-w3a');
  });

  it('MUTATION CHECK: streaming path (chatStream) — handler sees the full turn context', async () => {
    // This is THE regression. `turnContext.enter` (enterWith) does not survive
    // the generator's first `yield`, so before the fix `defined` was false.
    const h = harness(oneToolTurn());
    await drain(h.orchestrator);
    assert.equal(h.seen.length, 1, 'the probe tool never ran');
    const s = h.seen[0]!;
    assert.equal(s.defined, true, 'turnContext.current() was undefined in the tool handler');
    assert.ok(s.turnId && s.turnId.length > 0, 'no turnId in the tool handler');
    assert.equal(s.agentSlug, AGENT_SLUG);
    assert.equal(s.userId, 'u1');
    assert.equal(s.sessionScope, 'sess-w3a');
  });

  it('MUTATION CHECK: streaming turns do not leak each other`s context', async () => {
    // Two turns on the SAME orchestrator, interleaved at the generator level:
    // both streams are advanced alternately, so a single shared store (or an
    // `enterWith` that bleeds across async resources) shows up as a duplicate
    // turnId here.
    const a = harness(oneToolTurn());
    const b = harness(oneToolTurn());
    const genA = a.orchestrator.chatStream({ userMessage: 'a', sessionScope: 's-a', userId: 'ua' });
    const genB = b.orchestrator.chatStream({ userMessage: 'b', sessionScope: 's-b', userId: 'ub' });
    let doneA = false;
    let doneB = false;
    while (!doneA || !doneB) {
      if (!doneA) doneA = (await genA.next()).done === true;
      if (!doneB) doneB = (await genB.next()).done === true;
    }
    assert.equal(a.seen[0]?.userId, 'ua');
    assert.equal(b.seen[0]?.userId, 'ub');
    assert.notEqual(a.seen[0]?.turnId, b.seen[0]?.turnId, 'both turns shared one turnId');
    assert.equal(a.seen[0]?.sessionScope, 's-a');
    assert.equal(b.seen[0]?.sessionScope, 's-b');
  });

  it('MUTATION CHECK: a write onto the LIVE store survives to a later tool iteration', async () => {
    // `activePersonaSkillId` and `mcpInputReplayNote` are documented to be
    // MUTATED onto the live store inside the turn scope. A propagation fix that
    // re-created the context object per generator step would silently drop
    // those writes, so pin the behaviour: iteration 1 writes, iteration 2 reads.
    const observed: Array<string | undefined> = [];
    const registry = new NativeToolRegistry();
    registry.register(PROBE_TOOL, {
      handler: async () => {
        const ctx = turnContext.current();
        observed.push(ctx?.activePersonaSkillId);
        if (ctx) ctx.activePersonaSkillId = 'persona-x';
        return 'ok';
      },
      spec: {
        name: PROBE_TOOL,
        description: 'Mutates the live turn context.',
        input_schema: { type: 'object' as const, properties: {}, required: [] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      agentId: 'probe',
    });
    const orchestrator = new Orchestrator({
      provider: fakeProvider([
        toolCallStream([{ id: 'tu-1', name: PROBE_TOOL, input: {} }]),
        toolCallStream([{ id: 'tu-2', name: PROBE_TOOL, input: {} }]),
        textStream('fertig'),
      ]),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      agentId: AGENT_SLUG,
    });
    for await (const _ of orchestrator.chatStream({ userMessage: 'los', sessionScope: 's' })) {
      // drain
    }
    assert.deepEqual(observed, [undefined, 'persona-x'], 'live-store mutation was lost');
  });

  it('MUTATION CHECK: an abandoned stream still tears the turn down INSIDE the scope', async () => {
    // A web-ui client disconnecting mid-turn `break`s out of the `for await`.
    // The body's own `finally` (steering-bus teardown, privacy finalisation)
    // must still run, and must still see the turn context — outside it those
    // handlers would operate on the wrong (or no) turn.
    const registry = new NativeToolRegistry();
    registry.register(PROBE_TOOL, {
      handler: async () => 'ok',
      spec: {
        name: PROBE_TOOL,
        description: 'noop',
        input_schema: { type: 'object' as const, properties: {}, required: [] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      agentId: 'probe',
    });
    const orchestrator = new Orchestrator({
      provider: fakeProvider(oneToolTurn()),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: registry,
      agentId: AGENT_SLUG,
    });
    const seenByConsumer: Array<string | undefined> = [];
    for await (const event of orchestrator.chatStream({
      userMessage: 'los',
      sessionScope: 's-abandon',
    })) {
      seenByConsumer.push(turnContext.currentTurnId());
      if (event.type === 'tool_result') break; // client disconnected
    }
    // 1. The body's `finally` ran: the steering bus released this scope. An
    //    abandoned turn that stays "live" would accept steers forever.
    assert.equal(
      steeringBus.enqueue('s-abandon', 'nachtrag').live,
      false,
      'the turn was never torn down — steeringBus still reports it live',
    );
    // 2. The CONSUMER must never inherit the turn scope. That leak is exactly
    //    what `enterWith` produced, and it is why an audit row could be
    //    attributed to the consumer's ambient turn instead of this one.
    assert.deepEqual(
      [...new Set(seenByConsumer)],
      [undefined],
      'the turn scope leaked into the consumer',
    );
  });
});

// ── 2. the DOWNSTREAM consequence: the MCP audit row ────────────────────────

describe('MCP audit attribution on a streaming turn (W3-A)', () => {
  it('MUTATION CHECK: the audit row names the agent and the turn, not `unattributed`', async () => {
    const h = harness(oneToolTurn(), { callMcp: true });
    await drain(h.orchestrator);
    assert.equal(h.audit.length, 1, 'no mcp_call_log row was emitted');
    const row = h.audit[0]!;
    // Before the fix: 'unattributed' / null / null — on EVERY streaming turn.
    assert.equal(row.callerKind, 'agent');
    assert.ok(row.turnId !== null && row.turnId.length > 0, 'audit row has no turnId');
    assert.equal(row.callerAgent, AGENT_SLUG);
    assert.equal(row.turnId, h.seen[0]?.turnId, 'audit row and handler disagree on the turn');
    assert.equal(row.outcome, 'ok');
  });

  it('MUTATION CHECK: a per-user identity established by an outer scope reaches the audit row', async () => {
    // A channel adapter (Teams) establishes the caller identity in an OUTER ALS
    // scope and then consumes `chatStream` inside it — the same shape
    // `runWithChatParticipants` uses. Both the propagation fix AND the
    // `mcpUserKey` carry-over are required for this to be anything but
    // `unresolved`.
    const h = harness(oneToolTurn(), { callMcp: true });
    await turnContext.run(
      {
        turnId: 'outer-adapter-turn',
        turnDate: '2026-07-30',
        mcpUserKey: 'alice@example.com',
      },
      async () => {
        await drain(h.orchestrator);
      },
    );
    assert.equal(h.audit.length, 1, 'no mcp_call_log row was emitted');
    const row = h.audit[0]!;
    assert.notEqual(
      row.actingIdentity,
      UNRESOLVED_IDENTITY,
      'per_user delegation recorded `unresolved` despite a resolvable caller',
    );
    assert.equal(row.actingIdentity, 'alice@example.com');
    // The row must be attributed to THIS turn, never to the adapter's outer
    // placeholder scope — which is exactly what a leaked `enterWith` produced.
    assert.notEqual(row.turnId, 'outer-adapter-turn');
    assert.equal(row.callerAgent, AGENT_SLUG);
    assert.equal(h.seen[0]?.mcpUserKey, 'alice@example.com');
  });
});
