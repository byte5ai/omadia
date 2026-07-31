/**
 * Issue #547 (W5-2) — WHY the structured-output sidecar is NOT wired to the
 * chat client.
 *
 * #547 landed the producer (`McpManager.structuredSink`) as plumbing only. The
 * obvious next step is to wire that sink through the orchestrator onto the
 * terminal `done` stream event so the UI can render a card. This file is the
 * evidence that doing so, as the seam stands today, would be a PII leak — and
 * it is a regression guard: if someone later makes the sidecar mask, the
 * `LEAK` test below turns red and this file must be revisited on purpose.
 *
 * The asymmetry, stated exactly:
 *
 *   - A tool's TEXT result is interned at the dispatch seam. `dispatchTool`
 *     returns `internToolResultV4(...).digestText`, and the client-facing
 *     `tool_result` stream event carries precisely that return value
 *     (`orchestrator.ts:5330` builds the slot promise from `dispatchTool`;
 *     `:4934` resolves it; `:4977` puts it on the wire as `output`). So the
 *     browser sees the digest, not the rows.
 *
 *   - The STRUCTURED payload is emitted from inside `McpManager.callTool`
 *     (`mcpClient.ts:~880`), which sits strictly BELOW every dispatcher. It
 *     never crosses the privacy handle at all. `extractStructured` documents
 *     this intent outright: "Returns the payload exactly as the server sent
 *     it ... never a re-parse of the rendered string."
 *
 * That "strictly below every dispatcher" is why this file proves the property
 * using `ToolDispatchService` rather than a full `Orchestrator` turn: the sink
 * fires beneath the dispatcher, so the leak is dispatcher-independent. The
 * interning contract asserted here is the same one the chat path uses and is
 * documented as parity in `toolDispatchPrivacySeam.test.ts`.
 *
 * There is also no way to fix this inside W5-2's scope. The whole privacy
 * contract (`PrivacyTurnHandle`) is string-in/string-out:
 * `internToolResultV4({rawResult: string}) -> {digestText: string}`. Feeding a
 * structured payload through it returns a digest STRING — the structure the
 * card exists to render is destroyed, leaving something strictly worse than
 * the `ToolRow` that already shows that digest. Masking structure while
 * preserving it needs a NEW method on the published `@omadia/plugin-api`
 * surface plus a privacy-guard implementation and boot wiring. That is an
 * issue, not a commit.
 *
 * MUTATION-CHECK DISCIPLINE (same as `toolDispatchPrivacySeam.test.ts`): every
 * assertion inspects CONTENT that crosses a boundary. None asserts "a masking
 * function was called" — a call-count assertion stays green over a masking
 * function that returns its input unchanged, the exact false-green this repo
 * has been burned by. The privacy handle here performs a REAL redaction.
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

// Imported from SOURCE, not from the `@omadia/orchestrator` barrel. The barrel
// resolves to `dist/`, so a mutation applied to `src/` would not be visible
// without a rebuild — and a mutation check that silently exercises a stale
// artifact reports GREEN over broken production code. Same convention as
// `toolDispatchPrivacySeam.test.ts`. Keeping every orchestrator import on the
// source path also guarantees ONE module instance, so the `turnContext`
// AsyncLocalStorage the sidecar reads is the one this file writes.
import {
  McpManager,
  mcpNativeHandler,
  type McpServerConfig,
  type McpSidecarPayload,
  type McpStructuredOutputSidecar,
} from '../packages/harness-orchestrator/src/mcp/mcpClient.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { ToolDispatchService } from '../packages/harness-orchestrator/src/toolDispatchService.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import type { PrivacyTurnHandle } from '../packages/harness-orchestrator/src/privacyHandle.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const EMAIL = 'erika.mustermann@example.com';
const IBAN = 'DE89370400440532013000';
const PERSON = 'Erika Mustermann';

/** The tool's declared output shape — what a generic renderer would key off. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    email: { type: 'string' },
    iban: { type: 'string' },
  },
} as const;

/** The server answers with the SAME PII in both channels: the text block (which
 *  the dispatcher interns) and `structuredContent` (which nothing interns). */
const STRUCTURED_PAYLOAD = {
  name: PERSON,
  email: EMAIL,
  iban: IBAN,
} as const;

const TEXT_PAYLOAD = `{"name":"${PERSON}","email":"${EMAIL}","iban":"${IBAN}"}`;

const TOOL = 'crm_lookup_customer';

/**
 * A privacy handle that genuinely redacts, so a missing masking call shows up
 * as surviving raw PII rather than as an unmet expectation.
 */
function redactingPrivacyHandle(): PrivacyTurnHandle {
  return {
    async internToolResultV4({ toolName, rawResult }) {
      const redacted = rawResult
        .replaceAll(EMAIL, '[masked:email]')
        .replaceAll(IBAN, '[masked:iban]')
        .replaceAll(PERSON, '[masked:person]');
      return { digestText: `«dataset:${toolName}» ${redacted}`, datasetId: `ds-${toolName}` };
    },
    async recordBypassedTool() {
      /* no bypass configured in this file */
    },
    checkBypass() {
      return undefined;
    },
    async runV4Tool() {
      throw new Error('not used on this path');
    },
    async subAgentResultV4() {
      throw new Error('not used on this path');
    },
    async takeRenderedAnswerV4() {
      return undefined;
    },
    v4ToolSpecs() {
      return [];
    },
    async maskUserPrompt() {
      return { outcome: 'disabled' };
    },
    async restorePromptPseudonyms(text) {
      return text;
    },
    snapshotPromptRestorer() {
      return undefined;
    },
    async finalize() {
      return undefined;
    },
  };
}

// ── a real MCP server over a real socket ────────────────────────────────────

interface FakeServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

function buildMcpServerInstance(): McpSdkServer {
  const mcp = new McpSdkServer(
    { name: 'crm', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL,
        description: 'look up a customer record',
        inputSchema: { type: 'object' as const, properties: {} },
        outputSchema: OUTPUT_SCHEMA,
      },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text' as const, text: TEXT_PAYLOAD }],
    structuredContent: STRUCTURED_PAYLOAD,
  }));
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
const managers: McpManager[] = [];

// Teardown runs regardless of assertion outcome — a server closed only after a
// passing assertion turns a red run into a HANG, which is how a sibling agent's
// mutation check failed to report in this wave.
after(async () => {
  for (const m of managers) {
    try {
      await m.closeAll();
    } catch {
      /* teardown must not mask a test failure */
    }
  }
  await fake.close();
});

const CFG: McpServerConfig = {
  id: '00000000-0000-4000-8000-000000000547',
  name: 'Kunden-CRM',
  transport: 'http',
  endpoint: fake.url,
};

interface Harness {
  readonly manager: McpManager;
  readonly sidecars: McpSidecarPayload[];
  readonly service: ToolDispatchService;
}

/** Wire the REAL production chain: `ToolDispatchService` -> `NativeToolRegistry`
 *  -> `mcpNativeHandler` -> `McpManager.callTool` -> `structuredSink`. */
function harness(): Harness {
  const sidecars: McpSidecarPayload[] = [];
  const manager = new McpManager({ structuredSink: (p) => sidecars.push(p) });
  managers.push(manager);
  const nativeTools = new NativeToolRegistry();
  nativeTools.register(TOOL, {
    handler: mcpNativeHandler(manager, CFG, TOOL),
    spec: {
      name: TOOL,
      description: 'look up a customer record',
      input_schema: { type: 'object', properties: {} },
    },
    domain: 'mcp.kunden-crm',
  });
  const service = new ToolDispatchService({
    nativeTools,
    domainTools: [],
    privacy: () => redactingPrivacyHandle(),
  });
  return { manager, sidecars, service };
}

function structuredSidecars(
  sidecars: readonly McpSidecarPayload[],
): McpStructuredOutputSidecar[] {
  return sidecars.filter(
    (p): p is McpStructuredOutputSidecar => p.kind === 'structured_output',
  );
}

// ── the finding ─────────────────────────────────────────────────────────────

describe('#547 structured-output sidecar vs. the privacy boundary (W5-2)', () => {
  it('BASELINE — the TEXT result a client receives IS masked at the dispatch seam', async () => {
    const h = harness();

    const result = await h.service.dispatch(TOOL, {});

    // This is the benchmark the brief calls "the same terms as text output".
    assert.equal(
      result.content.includes(EMAIL),
      false,
      'the email reached the caller in clear — the text seam did not mask',
    );
    assert.equal(result.content.includes(IBAN), false, 'the IBAN reached the caller in clear');
    assert.equal(
      result.content.includes(PERSON),
      false,
      'the person name reached the caller in clear',
    );
    // Masked rather than dropped.
    assert.match(result.content, /\[masked:email\]/);
    assert.match(result.content, /«dataset:crm_lookup_customer»/);
  });

  it('LEAK — the STRUCTURED sidecar carries the same PII in CLEAR on the same call', async () => {
    const h = harness();

    const result = await h.service.dispatch(TOOL, {});

    // Same dispatch, same privacy handle installed, same PII.
    assert.equal(result.content.includes(EMAIL), false, 'precondition: the text WAS masked');

    const structured = structuredSidecars(h.sidecars);
    assert.equal(structured.length, 1, 'exactly one structured sidecar for one call');
    const payload = structured[0]!.structured as Record<string, unknown>;

    // The load-bearing assertions: raw values, byte-identical to what the
    // server sent. Wiring this payload onto the `done` event would put every
    // one of these into the browser on a turn where the text was masked.
    assert.equal(payload['email'], EMAIL);
    assert.equal(payload['iban'], IBAN);
    assert.equal(payload['name'], PERSON);
    assert.deepEqual(payload, STRUCTURED_PAYLOAD);
  });

  it('the sidecar is emitted BENEATH the dispatcher, so no dispatcher can mask it', async () => {
    // Proves the leak is structural rather than a property of one dispatcher:
    // the payload is already in the sink by the time `dispatch` returns, and
    // the value in the sink is unaffected by the masking that produced
    // `result.content`.
    const h = harness();

    const result = await h.service.dispatch(TOOL, {});

    const structured = structuredSidecars(h.sidecars);
    assert.equal(structured.length, 1);
    assert.match(result.content, /\[masked:person\]/, 'the string path was masked');
    assert.equal(
      (structured[0]!.structured as Record<string, unknown>)['name'],
      PERSON,
      'the sidecar payload was NOT masked by the same dispatch',
    );
  });

  it('carries the declared `outputSchema`, so a generic renderer is buildable once masking exists', async () => {
    // Not a leak assertion — it records that the ONLY blocker is masking. The
    // renderer contract the brief specifies (render from `outputSchema`, never
    // by tool name) is already satisfiable end-to-end over a real wire.
    const h = harness();
    await h.manager.listTools(CFG); // discovery caches the schema

    await h.service.dispatch(TOOL, {});

    const structured = structuredSidecars(h.sidecars);
    assert.equal(structured.length, 1);
    assert.deepEqual(structured[0]!.outputSchema, OUTPUT_SCHEMA);
  });

  it('attaches the ambient `turnId`, so correlation onto a done event is already possible', async () => {
    const h = harness();

    await turnContext.run(
      { turnId: 't-547', turnDate: '2026-07-31', agentSlug: 'main', userId: 'u1' } as never,
      () => h.service.dispatch(TOOL, {}),
    );

    const structured = structuredSidecars(h.sidecars);
    assert.equal(structured.length, 1);
    assert.equal(structured[0]!.turnId, 't-547');
  });

  it('emits NO sidecar for a tool whose result has no structuredContent', async () => {
    // The `ToolRow` fallback case the brief requires to survive untouched.
    const sidecars: McpSidecarPayload[] = [];
    const manager = new McpManager({ structuredSink: (p) => sidecars.push(p) });
    managers.push(manager);
    const nativeTools = new NativeToolRegistry();
    nativeTools.register('plain_tool', {
      handler: async () => 'just text',
      spec: {
        name: 'plain_tool',
        description: 'no structured output',
        input_schema: { type: 'object', properties: {} },
      },
      domain: 'test.plain',
    });
    const service = new ToolDispatchService({ nativeTools, domainTools: [] });

    const result = await service.dispatch('plain_tool', {});

    assert.equal(result.content, 'just text');
    assert.deepEqual(structuredSidecars(sidecars), []);
  });
});
