/**
 * Issue #544 / W2-1 — Privacy Shield v4 on the MCP input-replay note.
 *
 * The MCP input-replay path re-calls a parked tool in a LATER turn and folds
 * the result into the note that `withMcpInputNote` puts on the model's wire.
 * That result was NOT interned: the replayer calls `McpManager.callTool`
 * directly rather than through `dispatchTool`, so a personnel row coming back
 * from an HR/accounting MCP server reached the LLM provider in cleartext.
 *
 * Coverage:
 *   1. the replayed MCP result is interned before the note crosses the
 *      server ↔ LLM-provider boundary;
 *   2. an operator-flagged MCP privacy bypass still passes the replay result
 *      through raw on that boundary (exempt stays exempt, still functional);
 *   3. with no privacy handle the note keeps byte-identical legacy behaviour.
 *
 * WHY THE CARD IS PRE-SEEDED INTO THE STORE rather than parked by a real first
 * turn: with a privacy handle installed, `dispatchTool` interns EVERY
 * non-allowlisted tool result — including the `[mcp_input_required:<id>]`
 * sentinel — and `parseMcpInputSentinel` is deliberately anchored at the start
 * of the string, so the card never materialises at all. That is a SEPARATE,
 * pre-existing defect (Privacy Shield v4 vs. MRTR cards; `privacyInternPolicy.ts`
 * exempts by tool NAME only and no MCP tool is ever on that list), reported
 * alongside this fix and deliberately NOT papered over here. Pre-seeding the
 * store isolates the replay half — the code this file exists to pin — from it.
 * The full two-turn parking flow is covered by `mcpInputRequired.test.ts`.
 *
 * Imported from SOURCE, not from the `@omadia/orchestrator` barrel. The barrel
 * resolves to `dist/`, so a mutation in `src/` would otherwise be invisible
 * without a rebuild and a mutation check could report GREEN over stale code.
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
import type { PrivacyGuardService } from '@omadia/plugin-api';
import {
  InMemoryPendingMcpInputStore,
  type McpInputReplayer,
  type PendingMcpInput,
  formatMcpInputReply,
  resetSharedMcpInputWiring,
} from '../../packages/harness-orchestrator/src/mcp/pendingMcpInput.js';
import {
  McpManager,
  REPLAY_ARG_KEY,
  mcpNativeHandler,
  type McpServerConfig,
} from '../../packages/harness-orchestrator/src/mcp/mcpClient.js';
import { setMcpPrivacyBypassServers } from '../../packages/harness-orchestrator/src/mcpPrivacyBypass.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator } from '../../packages/harness-orchestrator/src/orchestrator.js';

const PERSON = 'Erika Mustermann';
const EMAIL = 'erika.mustermann@example.com';
const IBAN = 'DE89370400440532013000';
const RAW_ROW =
  `Personalakte: ${PERSON} | Email: ${EMAIL} | IBAN: ${IBAN} | Status: aktiv`;
const DIGEST_MARKER = '«dataset:lookup_employee_record»';
const MCP_TOOL_NAME = 'mcp__HR_Payroll__lookup_employee_record';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const serverArgs: Array<Record<string, unknown>> = [];
const managers = new Set<McpManager>();

function clearSharedState(): void {
  setMcpPrivacyBypassServers([]);
  resetSharedMcpInputWiring();
}

function redactingPrivacyService(): PrivacyGuardService {
  return {
    async internToolResultV4(request: { toolName: string; rawResult: string }) {
      const redacted = request.rawResult
        .replaceAll(PERSON, '[masked:person]')
        .replaceAll(EMAIL, '[masked:email]')
        .replaceAll(IBAN, '[masked:iban]');
      return {
        digestText: `${DIGEST_MARKER} ${redacted}`,
        datasetId: `ds-${request.toolName}`,
      };
    },
    async recordBypassedTool() {},
    async runV4Tool() {
      return { resultText: '' };
    },
    async subAgentResultV4() {
      return { resultText: '' };
    },
    async takeRenderedAnswerV4() {
      return undefined;
    },
    v4ToolSpecs() {
      return [];
    },
    async finalizeTurn() {
      return undefined;
    },
  } as unknown as PrivacyGuardService;
}

function buildMcpServerInstance(): McpSdkServer {
  const mcp = new McpSdkServer(
    { name: 'payroll', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'lookup_employee_record', inputSchema: { type: 'object' as const } }],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    serverArgs.push(args);
    const answers = args[REPLAY_ARG_KEY];
    if (answers !== undefined && answers !== null && typeof answers === 'object') {
      return {
        content: [{ type: 'text' as const, text: RAW_ROW }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: 'Bitte Personalnummer und PIN angeben.' }],
      resultType: 'input_required',
      inputRequests: [
        { name: 'employeeId', label: 'Personalnummer' },
        { name: 'pin', label: 'PIN', secret: true },
      ],
      message: 'Bitte Personalnummer und PIN angeben.',
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

const CFG: McpServerConfig = {
  id: '00000000-0000-4000-8000-000000000945',
  name: 'HR Payroll',
  transport: 'http',
  endpoint: fake.url,
};

// Teardown runs regardless of assertion outcome, and every step is
// individually guarded: a server closed only after a passing assertion turns a
// RED run into a HANG, which is how a sibling agent's mutation check in this
// wave failed to report at all. Swallowing here is correct — teardown must
// never mask the failure that is already being reported.
after(async () => {
  try {
    clearSharedState();
  } catch {
    /* teardown must not mask a test failure */
  }
  for (const manager of managers) {
    try {
      await manager.closeAll();
    } catch {
      /* teardown must not mask a test failure */
    }
  }
  try {
    await fake.close();
  } catch {
    /* teardown must not mask a test failure */
  }
});

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

function fakeStreamProvider(
  streams: LlmStreamEvent[][],
  seenRequests: LlmRequest[],
): LlmProvider {
  let idx = 0;
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      seenRequests.push(req);
      const events = streams[idx];
      idx += 1;
      if (!events) throw new Error(`no scripted stream for provider call ${String(idx)}`);
      const final = events.at(-1) as { response: LlmResponse };
      return final.response;
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      seenRequests.push(req);
      const events = streams[idx];
      idx += 1;
      if (!events) throw new Error(`no scripted stream for provider call ${String(idx)}`);
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

interface Harness {
  readonly orchestrator: Orchestrator;
  readonly seenRequests: LlmRequest[];
  readonly store: InMemoryPendingMcpInputStore;
}

function harness(
  streams: LlmStreamEvent[][],
  options?: { readonly privacyGuard?: () => PrivacyGuardService | undefined },
): Harness {
  const store = new InMemoryPendingMcpInputStore();
  const manager = new McpManager({ pendingInput: store });
  managers.add(manager);
  const registry = new NativeToolRegistry();
  registry.register(MCP_TOOL_NAME, {
    handler: mcpNativeHandler(manager, CFG, 'lookup_employee_record'),
    spec: {
      name: MCP_TOOL_NAME,
      description: 'Look up an employee record.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
    agentId: 'mcp-test',
  });
  const seenRequests: LlmRequest[] = [];
  const replayer: McpInputReplayer = {
    replay: async (record: PendingMcpInput, inputResponses: Record<string, string>) =>
      manager.callTool(CFG, record.toolName, {
        ...record.originalArgs,
        [REPLAY_ARG_KEY]: inputResponses,
      }),
  };
  const orchestrator = new Orchestrator({
    provider: fakeStreamProvider(streams, seenRequests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: registry,
    pendingMcpInput: store,
    mcpInputReplay: replayer,
    ...(options?.privacyGuard ? { privacyGuard: options.privacyGuard } : {}),
  });
  return { orchestrator, seenRequests, store };
}

async function runStream(
  orchestrator: Orchestrator,
  userMessage: string,
  sessionScope: string,
  userId: string,
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const ev of orchestrator.chatStream({ userMessage, sessionScope, userId })) {
    events.push(ev);
  }
  return events;
}

function doneEvent(events: ChatStreamEvent[]): {
  answer: string;
  pendingMcpInput?: PendingMcpInputCard;
} {
  const done = events.find((event) => event.type === 'done');
  assert.ok(done, 'no done event');
  return done as never;
}

function wireUserText(requests: readonly LlmRequest[]): string {
  const parts: string[] = [];
  for (const req of requests) {
    for (const message of (req.messages ?? []) as Array<{ role: string; content: unknown }>) {
      if (message.role !== 'user') continue;
      if (typeof message.content === 'string') {
        parts.push(message.content);
        continue;
      }
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<{ text?: string }>) {
        if (typeof block.text === 'string') parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

const SESSION = 'sess-1';
const USER = 'u1';

/**
 * Park a record and bind it to `(USER, SESSION)` exactly as a real first turn
 * would: `put` stores it ownerless, `claim` binds the owner. `take` during the
 * replay turn then needs the full `{userId, sessionId, correlationId}` triple,
 * so the #445 ownership defence is exercised rather than bypassed.
 */
function seedParkedCard(h: Harness, correlationId: string): void {
  const record: PendingMcpInput = {
    correlationId,
    serverId: CFG.id,
    serverName: CFG.name,
    toolName: 'lookup_employee_record',
    originalArgs: { caseId: 'HR-7' },
    inputRequests: [
      { name: 'employeeId', required: true },
      { name: 'pin', secret: true, required: true },
    ],
    replayDepth: 0,
  };
  assert.equal(h.store.put(record), 'stored');
  assert.ok(
    h.store.claim(correlationId, { userId: USER, sessionId: SESSION }),
    'the seeded record must claim, or the replay turn cannot take it',
  );
}

/**
 * Drive the replay turn and return the user-role text the LLM provider saw.
 * This is the wire the fix is about — the browser is on the trusted side and
 * is deliberately not asserted on here.
 */
async function replayWire(
  h: Harness,
  correlationId: string,
  inputResponses: Record<string, string>,
): Promise<string> {
  await runStream(
    h.orchestrator,
    formatMcpInputReply({ correlationId, inputResponses }),
    SESSION,
    USER,
  );
  return wireUserText(h.seenRequests);
}

describe('MCP input replay privacy boundary (#544 / W2-1)', () => {
  it('MUTATION CHECK: the replay note interns the MCP result before it reaches the LLM wire', async () => {
    clearSharedState();
    serverArgs.length = 0;
    const h = harness([textStream('fertig')], {
      privacyGuard: () => redactingPrivacyService(),
    });
    seedParkedCard(h, 'corr-intern');

    const wire = await replayWire(h, 'corr-intern', { employeeId: 'E-42', pin: '4321' });

    // The server DID return the row — otherwise "absent from the wire" would
    // pass vacuously over a replay that never happened.
    assert.ok(
      serverArgs.some((a) => a[REPLAY_ARG_KEY] !== undefined),
      'the replay never reached the MCP server',
    );
    assert.equal(wire.includes(PERSON), false, `person name crossed the wire: ${wire}`);
    assert.equal(wire.includes(EMAIL), false, `email crossed the wire: ${wire}`);
    assert.equal(wire.includes(IBAN), false, `IBAN crossed the wire: ${wire}`);
    assert.ok(wire.includes(DIGEST_MARKER), `digest marker missing from the wire: ${wire}`);
    assert.ok(wire.includes('[masked:person]'), `masked payload missing from the wire: ${wire}`);
  });

  it('MUTATION CHECK: an MCP privacy-bypass server keeps the replay result raw on the wire', async () => {
    clearSharedState();
    serverArgs.length = 0;
    setMcpPrivacyBypassServers([CFG.id]);
    try {
      const h = harness([textStream('fertig')], {
        privacyGuard: () => redactingPrivacyService(),
      });
      seedParkedCard(h, 'corr-bypass');

      const wire = await replayWire(h, 'corr-bypass', { employeeId: 'E-77', pin: '9999' });

      assert.ok(wire.includes(PERSON), `person name missing from bypassed wire text: ${wire}`);
      assert.ok(wire.includes(EMAIL), `email missing from bypassed wire text: ${wire}`);
      assert.ok(wire.includes(IBAN), `IBAN missing from bypassed wire text: ${wire}`);
      assert.equal(wire.includes(DIGEST_MARKER), false, `digest should not replace bypassed raw text: ${wire}`);
    } finally {
      setMcpPrivacyBypassServers([]);
    }
  });

  it('MUTATION CHECK: without a privacy handle the replay note stays legacy-raw byte-for-byte', async () => {
    clearSharedState();
    serverArgs.length = 0;
    const h = harness([textStream('fertig')]);
    seedParkedCard(h, 'corr-legacy');

    const wire = await replayWire(h, 'corr-legacy', { employeeId: 'E-99', pin: '1111' });

    assert.ok(wire.includes(RAW_ROW), `legacy raw replay result missing from the wire: ${wire}`);
    assert.equal(wire.includes(DIGEST_MARKER), false, `digest should not appear without privacy guard: ${wire}`);
  });
});
