/**
 * Issue #544 (W2-1) — the orchestrator half of MRTR mid-call user input.
 *
 * Covers, against a REAL fake MCP server reached through a real `McpManager`
 * and a real `Orchestrator` turn:
 *
 *  1. The turn short-circuits on a parked `input_required` result, and the
 *     `done` event carries `pendingMcpInput` — including the server attribution.
 *  2. `pendingUserChoice` is the deterministic winner when both are pending in
 *     the SAME tool batch, and the losing MCP record stays replayable.
 *  3. The full two-turn round trip: the card answer replays the call as an
 *     orchestrator-driven FORCED call, the collected values reach the server
 *     verbatim, and the reply envelope never reaches the wire or the log.
 *  4. Regression: an ordinary turn and an ordinary `ask_user_choice` turn are
 *     unaffected, since the short-circuit path is shared.
 *
 * Tests labelled MUTATION CHECK were verified by breaking the invariant,
 * rebuilding, and confirming this assertion turns red.
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
import type { ChatStreamEvent, PendingMcpInputCard } from '@omadia/channel-sdk';
import {
  AskUserChoiceTool,
  InMemoryPendingMcpInputStore,
  MCP_INPUT_REQUIRED_SENTINEL_PREFIX,
  McpManager,
  NativeToolRegistry,
  Orchestrator,
  REPLAY_ARG_KEY,
  formatMcpInputReply,
  mcpNativeHandler,
  type McpInputReplayer,
  type McpServerConfig,
} from '@omadia/orchestrator';

// ── fake MCP server ─────────────────────────────────────────────────────────

/** Arguments the server saw, so replay assertions read the SERVER's view. */
const serverArgs: Array<Record<string, unknown>> = [];

function buildMcpServerInstance(): McpSdkServer {
  const mcp = new McpSdkServer(
    { name: 'fake-crm', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'create_ticket', inputSchema: { type: 'object' as const } }],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    serverArgs.push(args);
    const answers = args[REPLAY_ARG_KEY];
    if (answers !== undefined && answers !== null && typeof answers === 'object') {
      const responses = answers as Record<string, unknown>;
      return {
        content: [
          {
            type: 'text' as const,
            text: `Ticket TCK-77 für ${String(responses['customerNumber'])} angelegt (subject=${String(args['subject'])})`,
          },
        ],
      };
    }
    return {
      content: [{ type: 'text' as const, text: 'Angaben fehlen.' }],
      resultType: 'input_required',
      inputRequests: [
        { name: 'customerNumber', label: 'Kundennummer' },
        { name: 'pin', label: 'PIN', secret: true },
      ],
      message: 'Bitte Kundennummer und PIN angeben.',
    } as never;
  });
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
  id: '00000000-0000-4000-8000-000000000544',
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

function fakeStreamProvider(
  streams: LlmStreamEvent[][],
  seenRequests: LlmRequest[],
): LlmProvider {
  let idx = 0;
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    // The BUFFERED path (`runTurn`) calls `complete()`, the streaming path
    // calls `stream()`. Both are served from the same script so a single
    // scenario definition covers each path identically.
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      seenRequests.push(req);
      if (idx >= streams.length) {
        throw new Error(`no scripted stream for provider call ${String(idx + 1)}`);
      }
      const events = streams[idx]!;
      idx += 1;
      const final = events.at(-1) as { type: string; response: LlmResponse };
      return final.response;
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      seenRequests.push(req);
      if (idx >= streams.length) {
        throw new Error(`no scripted stream for provider call ${String(idx + 1)}`);
      }
      const events = streams[idx]!;
      idx += 1;
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

const MCP_TOOL_NAME = 'mcp__Kunden_CRM__create_ticket';

interface Harness {
  readonly orchestrator: Orchestrator;
  readonly store: InMemoryPendingMcpInputStore;
  readonly seenRequests: LlmRequest[];
  readonly replayCalls: Array<{ toolName: string; responses: Record<string, string> }>;
}

function harness(
  streams: LlmStreamEvent[][],
  opts?: { readonly withChoiceTool?: boolean; readonly noReplayer?: boolean },
): Harness {
  const store = new InMemoryPendingMcpInputStore();
  const manager = new McpManager({ pendingInput: store });
  const registry = new NativeToolRegistry();
  registry.register(MCP_TOOL_NAME, {
    handler: mcpNativeHandler(manager, CFG, 'create_ticket'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec: {
      name: MCP_TOOL_NAME,
      description: 'Create a CRM ticket.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    agentId: 'mcp-test',
  });
  const seenRequests: LlmRequest[] = [];
  const replayCalls: Array<{ toolName: string; responses: Record<string, string> }> = [];
  const replayer: McpInputReplayer = {
    replay: async (record, inputResponses) => {
      replayCalls.push({ toolName: record.toolName, responses: inputResponses });
      return manager.callTool(CFG, record.toolName, {
        ...record.originalArgs,
        [REPLAY_ARG_KEY]: inputResponses,
      });
    },
  };
  const orchestrator = new Orchestrator({
    provider: fakeStreamProvider(streams, seenRequests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: registry,
    pendingMcpInput: store,
    ...(opts?.noReplayer ? {} : { mcpInputReplay: replayer }),
    ...(opts?.withChoiceTool ? { askUserChoiceTool: new AskUserChoiceTool() } : {}),
  });
  return { orchestrator, store, seenRequests, replayCalls };
}

async function runStream(
  orchestrator: Orchestrator,
  userMessage: string,
  sessionScope?: string,
  userId?: string,
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const ev of orchestrator.chatStream({
    userMessage,
    ...(sessionScope !== undefined ? { sessionScope } : {}),
    ...(userId !== undefined ? { userId } : {}),
  })) {
    events.push(ev);
  }
  return events;
}

function doneEvent(events: ChatStreamEvent[]): {
  answer: string;
  pendingMcpInput?: PendingMcpInputCard;
  pendingUserChoice?: unknown;
} {
  const done = events.find((e) => e.type === 'done');
  assert.ok(done, 'no done event');
  return done as never;
}

/** Every user-role text the provider actually saw, flattened. */
function wireUserText(requests: readonly LlmRequest[]): string {
  const parts: string[] = [];
  for (const req of requests) {
    for (const m of (req.messages ?? []) as Array<{ role: string; content: unknown }>) {
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') parts.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const block of m.content as Array<{ type?: string; text?: string }>) {
          if (typeof block.text === 'string') parts.push(block.text);
        }
      }
    }
  }
  return parts.join('\n');
}

// ── 1. short-circuit ────────────────────────────────────────────────────────

describe('MCP input_required short-circuits the turn (#544 W2-1)', () => {
  it('MUTATION CHECK: ends the turn and reports pendingMcpInput without a second model call', async () => {
    const h = harness([
      toolCallStream([{ id: 'tu-1', name: MCP_TOOL_NAME, input: { subject: 'Drucker' } }]),
      // Deliberately scripted so a SECOND provider call is possible. If the
      // short-circuit is removed the orchestrator consumes it and `done` has no
      // `pendingMcpInput` — this asserts the turn ENDED, not merely that a field
      // is populated.
      textStream('sollte nie erreicht werden'),
    ]);
    const events = await runStream(h.orchestrator, 'Ticket anlegen', 'sess-1', 'u1');
    const done = doneEvent(events);
    assert.ok(done.pendingMcpInput, 'no pendingMcpInput on the done event');
    assert.equal(h.seenRequests.length, 1, 'the model was called again after the park');
    assert.notEqual(done.answer, 'sollte nie erreicht werden');
  });

  it('MUTATION CHECK: the card names the asking server', async () => {
    const h = harness([
      toolCallStream([{ id: 'tu-1', name: MCP_TOOL_NAME, input: {} }]),
      textStream('x'),
    ]);
    const card = doneEvent(
      await runStream(h.orchestrator, 'Ticket', 'sess-1', 'u1'),
    ).pendingMcpInput;
    assert.ok(card);
    // Mandatory attribution: a hostile server must not be able to render a
    // credential prompt that looks like omadia's own UI. Dropping `serverName`
    // from `toPendingMcpInputCard` turns this red.
    assert.equal(card.serverName, 'Kunden-CRM');
    assert.equal(card.serverId, CFG.id);
    assert.equal(card.toolName, 'create_ticket');
    assert.equal(card.prompt, 'Bitte Kundennummer und PIN angeben.');
    assert.deepEqual(
      card.fields.map((f) => f.name),
      ['customerNumber', 'pin'],
    );
    assert.equal(card.fields[1]?.secret, true);
    assert.ok(card.correlationId.length > 0);
    // The card must NOT leak the original arguments back to the channel.
    assert.equal((card as Record<string, unknown>)['originalArgs'], undefined);
  });

  it('MUTATION CHECK: the model never sees a fabricated tool result, only the sentinel', async () => {
    const h = harness([
      toolCallStream([{ id: 'tu-1', name: MCP_TOOL_NAME, input: {} }]),
      textStream('x'),
    ]);
    await runStream(h.orchestrator, 'Ticket', 'sess-1', 'u1');
    // The sentinel rides the tool_result of the SAME batch, so it is in the
    // messages the (never-issued) next request would have carried. Asserting the
    // orchestrator did not instead hand the model the server's "Angaben fehlen."
    // text as if the call had succeeded.
    const events = await runStream(
      harness([
        toolCallStream([{ id: 'tu-1', name: MCP_TOOL_NAME, input: {} }]),
        textStream('x'),
      ]).orchestrator,
      'Ticket',
      'sess-1',
      'u1',
    );
    const results = events.filter((e) => e.type === 'tool_result') as Array<{
      output?: string;
    }>;
    assert.ok(results.length > 0, 'no tool_result event observed');
    assert.ok(
      results.some((r) => (r.output ?? '').startsWith(MCP_INPUT_REQUIRED_SENTINEL_PREFIX)),
      `expected the sentinel in a tool_result, saw: ${JSON.stringify(results)}`,
    );
  });

  it('degrades to an ordinary tool error when no replayer is wired', async () => {
    // Store present, replayer absent → `buildOrchestrator` would not enable the
    // path at all; constructing it directly proves the orchestrator still
    // behaves (the card renders, the answer just cannot be replayed later).
    const h = harness(
      [toolCallStream([{ id: 'tu-1', name: MCP_TOOL_NAME, input: {} }]), textStream('x')],
      { noReplayer: true },
    );
    const done = doneEvent(await runStream(h.orchestrator, 'Ticket', 'sess-1', 'u1'));
    assert.ok(done.pendingMcpInput);
  });
});

// ── 2. deterministic winner ─────────────────────────────────────────────────

describe('both pendings in one batch (#544 W2-1)', () => {
  it('MUTATION CHECK: pendingUserChoice wins deterministically and the MCP record survives', async () => {
    const h = harness(
      [
        // ONE batch, both tools. Dispatch order must not decide the outcome.
        toolCallStream([
          { id: 'tu-1', name: MCP_TOOL_NAME, input: { subject: 'A' } },
          {
            id: 'tu-2',
            name: 'ask_user_choice',
            input: { question: 'Welches System?', options: [{ label: 'CRM' }, { label: 'ERP' }] },
          },
        ]),
        textStream('x'),
      ],
      { withChoiceTool: true },
    );
    const done = doneEvent(await runStream(h.orchestrator, 'Ticket', 'sess-1', 'u1'));
    // The winner, asserted in BOTH directions: a rule that merely "prefers" the
    // choice card while still emitting the MCP card would pass a one-sided check.
    assert.ok(done.pendingUserChoice, 'the choice card must win');
    assert.equal(done.pendingMcpInput, undefined, 'the MCP card must not also ship');
    // …and the loser is not destroyed: the parked call is still replayable, so
    // the user can resolve the clarification and continue.
    assert.equal(h.store.size(), 1, 'the losing MCP record was discarded');
  });

  it('MUTATION CHECK: reversing the batch order does not change the winner', async () => {
    const h = harness(
      [
        toolCallStream([
          {
            id: 'tu-1',
            name: 'ask_user_choice',
            input: { question: 'Welches System?', options: [{ label: 'CRM' }, { label: 'ERP' }] },
          },
          { id: 'tu-2', name: MCP_TOOL_NAME, input: {} },
        ]),
        textStream('x'),
      ],
      { withChoiceTool: true },
    );
    const done = doneEvent(await runStream(h.orchestrator, 'Ticket', 'sess-1', 'u1'));
    // Same outcome as the previous test with the batch reversed — that is what
    // "deterministic" means here. A `??`-style "whichever drained first" rule
    // turns exactly one of these two red.
    assert.ok(done.pendingUserChoice);
    assert.equal(done.pendingMcpInput, undefined);
  });
});

// ── 3. the two-turn round trip ──────────────────────────────────────────────

describe('two-turn replay through the orchestrator (#544 W2-1)', () => {
  it('MUTATION CHECK: the collected values reach the server verbatim in a later turn', async () => {
    serverArgs.length = 0;
    const h = harness([
      toolCallStream([{ id: 'tu-1', name: MCP_TOOL_NAME, input: { subject: 'Drucker kaputt' } }]),
      // Turn 2: no tool call at all. The replay is orchestrator-driven, so the
      // model only narrates — if the replay had been left to the model, this
      // pure-text script would produce NO server call and the test would fail.
      textStream('Ticket TCK-77 ist angelegt.'),
    ]);

    const card = doneEvent(
      await runStream(h.orchestrator, 'Ticket anlegen', 'sess-1', 'u1'),
    ).pendingMcpInput;
    assert.ok(card);

    const envelope = formatMcpInputReply({
      correlationId: card.correlationId,
      inputResponses: { customerNumber: 'K-1234', pin: '9876' },
    });
    const done2 = doneEvent(await runStream(h.orchestrator, envelope, 'sess-1', 'u1'));

    // The FORCED call happened, exactly once, with the right arguments…
    assert.equal(h.replayCalls.length, 1);
    assert.deepEqual(h.replayCalls[0], {
      toolName: 'create_ticket',
      responses: { customerNumber: 'K-1234', pin: '9876' },
    });
    // …asserted at the SERVER, not at our own call site: original args survive
    // and the collected values arrive unmangled.
    assert.deepEqual(serverArgs.at(-1), {
      subject: 'Drucker kaputt',
      inputResponses: { customerNumber: 'K-1234', pin: '9876' },
    });
    assert.equal(done2.answer, 'Ticket TCK-77 ist angelegt.');
    assert.equal(done2.pendingMcpInput, undefined, 'the replay must not re-park');
  });

  it('MUTATION CHECK: the replayed result reaches the model, and the envelope never does', async () => {
    const h = harness([
      toolCallStream([{ id: 'tu-1', name: MCP_TOOL_NAME, input: { subject: 'Drucker kaputt' } }]),
      textStream('fertig'),
    ]);
    const card = doneEvent(
      await runStream(h.orchestrator, 'Ticket anlegen', 'sess-1', 'u1'),
    ).pendingMcpInput;
    assert.ok(card);
    h.seenRequests.length = 0;

    await runStream(
      h.orchestrator,
      formatMcpInputReply({
        correlationId: card.correlationId,
        inputResponses: { customerNumber: 'K-1234', pin: 'geheim-9876' },
      }),
      'sess-1',
      'u1',
    );
    const wire = wireUserText(h.seenRequests);

    // The model must be able to narrate the outcome: the replayed result is on
    // the wire. Dropping `withMcpInputNote` turns this red.
    assert.ok(wire.includes('TCK-77'), `replayed result missing from the wire: ${wire}`);
    assert.ok(wire.includes('Kunden-CRM'), 'the server attribution is missing');
    // The machine envelope must NOT be: it is replaced by a human label before
    // any downstream reader (wire, session log, memory, transcript) sees it.
    assert.ok(!wire.includes('__mcp_input_reply__'), `raw envelope reached the wire: ${wire}`);
    assert.ok(wire.includes('Eingaben übermittelt'), 'the human label is missing');
    // And the SECRET the user typed must not be echoed into the prompt by the
    // note — only the field NAMES are.
    assert.ok(!wire.includes('geheim-9876'), `a secret value reached the wire: ${wire}`);
    assert.ok(wire.includes('customerNumber'), 'field names should be listed');
  });

  it('MUTATION CHECK: a stale or foreign correlationId is refused, not looked up by id', async () => {
    const h = harness([textStream('kann ich nicht mehr')]);
    const events = await runStream(
      h.orchestrator,
      formatMcpInputReply({
        correlationId: 'never-parked',
        inputResponses: { customerNumber: 'K-1' },
      }),
      'sess-1',
      'u1',
    );
    doneEvent(events);
    // No replay may fire for an id that was never parked under this identity.
    // Widening the lookup to "by correlationId" would fire one — and that is
    // exactly the #445 cross-user shape.
    assert.equal(h.replayCalls.length, 0);
    assert.ok(wireUserText(h.seenRequests).includes('nicht mehr gültig'));
  });

  it('MUTATION CHECK: a card parked for one session cannot be answered from another', async () => {
    const h = harness([
      toolCallStream([{ id: 'tu-1', name: MCP_TOOL_NAME, input: {} }]),
      textStream('x'),
    ]);
    const card = doneEvent(
      await runStream(h.orchestrator, 'Ticket', 'sess-VICTIM', 'u1'),
    ).pendingMcpInput;
    assert.ok(card);

    // Same user, same correlationId, DIFFERENT session — the store key is the
    // triple, so this misses. Keying on `sessionScope` alone (or on the id
    // alone) turns this red, which is the whole point of #445.
    await runStream(
      h.orchestrator,
      formatMcpInputReply({
        correlationId: card.correlationId,
        inputResponses: { customerNumber: 'K-STOLEN' },
      }),
      'sess-ATTACKER',
      'u1',
    );
    assert.equal(h.replayCalls.length, 0, 'a cross-session replay fired');

    // Same session, DIFFERENT user — also a miss.
    await runStream(
      h.orchestrator,
      formatMcpInputReply({
        correlationId: card.correlationId,
        inputResponses: { customerNumber: 'K-STOLEN' },
      }),
      'sess-VICTIM',
      'u2',
    );
    assert.equal(h.replayCalls.length, 0, 'a cross-user replay fired');
  });
});

// ── 3b. the BUFFERED path (runTurn) ─────────────────────────────────────────
//
// `chatInContextInner` carries a hand-mirrored copy of the streaming
// short-circuit, the winner rule and the envelope normalisation. A mutation run
// proved these are NOT covered by the streaming tests above: breaking only the
// buffered copy left the whole suite green. Non-streaming callers (Teams and
// every `chat()`/`runTurn()` consumer) go through exactly this code, so it gets
// its own coverage rather than trusting the mirror to stay in sync.

async function runBuffered(
  orchestrator: Orchestrator,
  userMessage: string,
  sessionScope?: string,
  userId?: string,
): Promise<{ answer: string; pendingMcpInput?: PendingMcpInputCard; pendingUserChoice?: unknown }> {
  return orchestrator.runTurn({
    userMessage,
    ...(sessionScope !== undefined ? { sessionScope } : {}),
    ...(userId !== undefined ? { userId } : {}),
  }) as never;
}

describe('buffered path — runTurn (#544 W2-1)', () => {
  it('MUTATION CHECK: short-circuits and reports pendingMcpInput', async () => {
    const h = harness([
      toolCallStream([{ id: 'tu-1', name: MCP_TOOL_NAME, input: { subject: 'Drucker' } }]),
      textStream('sollte nie erreicht werden'),
    ]);
    const result = await runBuffered(h.orchestrator, 'Ticket anlegen', 'sess-1', 'u1');
    assert.ok(result.pendingMcpInput, 'no pendingMcpInput from runTurn');
    assert.equal(result.pendingMcpInput.serverName, 'Kunden-CRM');
    assert.equal(h.seenRequests.length, 1, 'the model was called again after the park');
  });

  it('MUTATION CHECK: pendingUserChoice wins here too', async () => {
    const h = harness(
      [
        toolCallStream([
          { id: 'tu-1', name: MCP_TOOL_NAME, input: {} },
          {
            id: 'tu-2',
            name: 'ask_user_choice',
            input: { question: 'Welches System?', options: [{ label: 'CRM' }, { label: 'ERP' }] },
          },
        ]),
        textStream('x'),
      ],
      { withChoiceTool: true },
    );
    const result = await runBuffered(h.orchestrator, 'Ticket', 'sess-1', 'u1');
    // The buffered copy of the winner rule, pinned independently of the
    // streaming one — a change applied to only one of the two turns this red.
    assert.ok(result.pendingUserChoice, 'the choice card must win on the buffered path');
    assert.equal(result.pendingMcpInput, undefined);
    assert.equal(h.store.size(), 1, 'the losing MCP record was discarded');
  });

  it('MUTATION CHECK: replays on the buffered path, and the envelope never reaches the wire', async () => {
    serverArgs.length = 0;
    const h = harness([
      toolCallStream([{ id: 'tu-1', name: MCP_TOOL_NAME, input: { subject: 'Drucker kaputt' } }]),
      textStream('Ticket ist angelegt.'),
    ]);
    const card = (await runBuffered(h.orchestrator, 'Ticket anlegen', 'sess-1', 'u1'))
      .pendingMcpInput;
    assert.ok(card);
    h.seenRequests.length = 0;

    const second = await runBuffered(
      h.orchestrator,
      formatMcpInputReply({
        correlationId: card.correlationId,
        inputResponses: { customerNumber: 'K-1234', pin: 'geheim-9876' },
      }),
      'sess-1',
      'u1',
    );

    assert.equal(h.replayCalls.length, 1, 'the buffered path did not replay');
    assert.deepEqual(serverArgs.at(-1), {
      subject: 'Drucker kaputt',
      inputResponses: { customerNumber: 'K-1234', pin: 'geheim-9876' },
    });
    assert.equal(second.answer, 'Ticket ist angelegt.');
    const wire = wireUserText(h.seenRequests);
    assert.ok(wire.includes('TCK-77'), `replayed result missing from the wire: ${wire}`);
    // The envelope normalisation in `runTurn` — its own code, its own test.
    assert.ok(!wire.includes('__mcp_input_reply__'), `raw envelope reached the wire: ${wire}`);
    assert.ok(wire.includes('Eingaben übermittelt'));
    assert.ok(!wire.includes('geheim-9876'), 'a secret value reached the wire');
  });

  it('a cross-session answer is refused on the buffered path', async () => {
    const h = harness([
      toolCallStream([{ id: 'tu-1', name: MCP_TOOL_NAME, input: {} }]),
      textStream('x'),
    ]);
    const card = (await runBuffered(h.orchestrator, 'Ticket', 'sess-VICTIM', 'u1'))
      .pendingMcpInput;
    assert.ok(card);
    await runBuffered(
      h.orchestrator,
      formatMcpInputReply({
        correlationId: card.correlationId,
        inputResponses: { customerNumber: 'K-STOLEN' },
      }),
      'sess-ATTACKER',
      'u1',
    );
    assert.equal(h.replayCalls.length, 0);
  });
});

// ── 4. regression: the shared short-circuit path ────────────────────────────

describe('regression — the shared short-circuit path (#544 W2-1)', () => {
  it('an ordinary turn is unaffected', async () => {
    const h = harness([textStream('Hallo!')]);
    const done = doneEvent(await runStream(h.orchestrator, 'Hi', 'sess-1', 'u1'));
    assert.equal(done.answer, 'Hallo!');
    assert.equal(done.pendingMcpInput, undefined);
    assert.equal(h.store.size(), 0);
  });

  it('an ordinary ask_user_choice turn still short-circuits with only a choice card', async () => {
    const h = harness(
      [
        toolCallStream([
          {
            id: 'tu-1',
            name: 'ask_user_choice',
            input: { question: 'Welches Modul?', options: [{ label: 'Sales' }, { label: 'POS' }] },
          },
        ]),
        textStream('nie erreicht'),
      ],
      { withChoiceTool: true },
    );
    const done = doneEvent(await runStream(h.orchestrator, 'Frage', 'sess-1', 'u1'));
    assert.ok(done.pendingUserChoice);
    assert.equal(done.pendingMcpInput, undefined);
    assert.equal(h.seenRequests.length, 1);
  });

  it('a successful MCP call is untouched by the MRTR path', async () => {
    // Same tool, but the call already carries `inputResponses`, so the fake
    // server answers normally: the park branch must not fire on a success.
    const h = harness([
      toolCallStream([
        {
          id: 'tu-1',
          name: MCP_TOOL_NAME,
          input: { subject: 'S', [REPLAY_ARG_KEY]: { customerNumber: 'K-9' } },
        },
      ]),
      textStream('erledigt'),
    ]);
    const done = doneEvent(await runStream(h.orchestrator, 'Ticket', 'sess-1', 'u1'));
    assert.equal(done.answer, 'erledigt');
    assert.equal(done.pendingMcpInput, undefined);
    assert.equal(h.store.size(), 0);
    assert.equal(h.seenRequests.length, 2, 'the turn should have continued normally');
  });
});
