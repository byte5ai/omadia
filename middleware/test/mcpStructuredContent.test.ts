/**
 * Issue #547 (W1-3) — MCP structured-content sidecar + outputSchema capture.
 *
 * Three things are locked down here:
 *
 *  1. A GOLDEN/characterization suite for `renderToolResult`. The model-facing
 *     string is the contract every downstream hop (Privacy Shield, KG ingest,
 *     session log, the LLM itself) depends on. These goldens were captured from
 *     the pre-change implementation; any diff in them is a behaviour change, not
 *     a test that needs updating.
 *  2. `extractStructured` — the new, SEPARATE reader for `structuredContent`.
 *  3. The out-of-band sink: installing one must not move a single byte of the
 *     model-facing string (the mutation check below), and the payload must be
 *     the parsed object the server sent, not a re-parse of the rendered text.
 *
 * Lives in its own file (not `mcpClient.test.ts`) to stay merge-conflict-free
 * with the parallel unit creating that file.
 */

import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  McpManager,
  extractStructured,
  mcpNativeHandler,
  renderToolResult,
  turnContext,
  type McpServerConfig,
  type McpSidecarPayload,
  type McpToolDescriptor,
} from '@omadia/orchestrator';

// ── 1. renderToolResult golden suite ────────────────────────────────────────

/** Captured from the implementation BEFORE the sidecar work. Each entry is
 *  [label, result, exact expected string]. */
const RENDER_GOLDENS: ReadonlyArray<readonly [string, unknown, string]> = [
  ['text-only', { content: [{ type: 'text', text: 'hello world' }] }, 'hello world'],
  [
    'mixed blocks (text + resource + unknown block)',
    {
      content: [
        { type: 'text', text: 'line one' },
        { type: 'resource', resource: { uri: 'file:///a.txt', text: 'from resource' } },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    },
    'line one\nfrom resource\n{"type":"image","data":"AAAA","mimeType":"image/png"}',
  ],
  [
    'structuredContent-only (no content array)',
    { structuredContent: { city: 'Berlin', tempC: 21 } },
    '{"city":"Berlin","tempC":21}',
  ],
  ['empty content array', { content: [] }, '[]'],
  [
    // The content-array branch wins even when structuredContent is present —
    // an empty array renders as "[]", NOT as the structured payload.
    'empty content array + structuredContent',
    { content: [], structuredContent: { a: 1 } },
    '[]',
  ],
  [
    // Off-spec: the MCP spec requires an object here, but hosted proxies (e.g.
    // the Strava proxy) send arrays. This is exactly why the lenient schema
    // exists — the string form must stay stable for those servers too.
    'array-valued structuredContent',
    { structuredContent: [{ id: 1 }, { id: 2 }] },
    '[{"id":1},{"id":2}]',
  ],
  [
    'content AND structuredContent — content wins',
    { content: [{ type: 'text', text: 'Weather: 21C' }], structuredContent: { tempC: 21 } },
    'Weather: 21C',
  ],
  ['isError result', { content: [{ type: 'text', text: 'boom' }], isError: true }, 'Error: boom'],
  [
    'whitespace-only text falls back to the raw content JSON',
    { content: [{ type: 'text', text: '   ' }] },
    '[{"type":"text","text":"   "}]',
  ],
  ['null result', null, '{}'],
  ['undefined result', undefined, '{}'],
  ['empty object result', {}, '{}'],
];

describe('renderToolResult golden suite (#547 W1-3 characterization)', () => {
  for (const [label, res, expected] of RENDER_GOLDENS) {
    it(`renders ${label} byte-identically`, () => {
      assert.equal(renderToolResult(res), expected);
    });
  }

  it('never returns a non-string', () => {
    for (const [, res] of RENDER_GOLDENS) {
      assert.equal(typeof renderToolResult(res), 'string');
    }
  });
});

// ── 2. extractStructured ────────────────────────────────────────────────────

describe('extractStructured (#547 W1-3)', () => {
  it('returns an object payload as-is', () => {
    const payload = { city: 'Berlin', tempC: 21 };
    const out = extractStructured({ content: [], structuredContent: payload });
    assert.deepEqual(out, payload);
  });

  it('preserves object identity — it is the parsed payload, not a re-parse', () => {
    const payload = { nested: { deep: true } };
    const out = extractStructured({ structuredContent: payload });
    assert.equal(out, payload);
  });

  it('returns an off-spec array payload unnormalised', () => {
    const out = extractStructured({ structuredContent: [{ id: 1 }, { id: 2 }] });
    assert.deepEqual(out, [{ id: 1 }, { id: 2 }]);
    assert.ok(Array.isArray(out));
  });

  it('returns a scalar payload as-is', () => {
    assert.equal(extractStructured({ structuredContent: 42 }), 42);
    assert.equal(extractStructured({ structuredContent: 'plain' }), 'plain');
    assert.equal(extractStructured({ structuredContent: false }), false);
  });

  it('folds an explicit null payload into "absent"', () => {
    assert.equal(extractStructured({ structuredContent: null }), undefined);
  });

  it('returns undefined when structuredContent is absent', () => {
    assert.equal(extractStructured({ content: [{ type: 'text', text: 'hi' }] }), undefined);
    assert.equal(extractStructured({}), undefined);
  });

  it('returns undefined on an isError result even when a payload is present', () => {
    assert.equal(
      extractStructured({ content: [], isError: true, structuredContent: { e: 1 } }),
      undefined,
    );
  });

  it('returns undefined for non-object results', () => {
    assert.equal(extractStructured(null), undefined);
    assert.equal(extractStructured(undefined), undefined);
    assert.equal(extractStructured('a string'), undefined);
    assert.equal(extractStructured(7), undefined);
  });
});

// ── 3. listTools outputSchema capture ───────────────────────────────────────

const OBJECT_SCHEMA = {
  type: 'object',
  properties: { tempC: { type: 'number' } },
  required: ['tempC'],
} as const;

const STUB_CFG: McpServerConfig = {
  id: '00000000-0000-4000-8000-00000000f001',
  name: 'stub-server',
  transport: 'http',
  endpoint: 'http://127.0.0.1:9/mcp',
};

/** Swap the manager's private connect step for a canned `tools/list` reply.
 *  Necessary because the SDK's client-side result schema rejects a malformed
 *  `outputSchema` outright, so the "non-object" case can't be exercised over a
 *  real wire — but the mapping still has to drop it rather than propagate it. */
function managerWithToolList(tools: readonly unknown[]): McpManager {
  const manager = new McpManager();
  (
    manager as unknown as {
      getOrConnect: () => Promise<{ client: { listTools: () => Promise<unknown> } }>;
    }
  ).getOrConnect = async () => ({ client: { listTools: async () => ({ tools }) } });
  return manager;
}

describe('McpManager.listTools outputSchema capture (#547 W1-3)', () => {
  it('copies outputSchema when the server declares one', async () => {
    const manager = managerWithToolList([
      { name: 'get_weather', description: 'w', inputSchema: { type: 'object' }, outputSchema: OBJECT_SCHEMA },
    ]);
    const [tool] = await manager.listTools(STUB_CFG);
    assert.deepEqual(tool?.outputSchema, OBJECT_SCHEMA);
    // The pre-existing fields must be untouched.
    assert.equal(tool?.name, 'get_weather');
    assert.equal(tool?.description, 'w');
    assert.deepEqual(tool?.inputSchema, { type: 'object' });
  });

  it('omits the key entirely when the server declares no outputSchema', async () => {
    const manager = managerWithToolList([{ name: 'ping', inputSchema: { type: 'object' } }]);
    const [tool] = await manager.listTools(STUB_CFG);
    assert.equal(tool?.outputSchema, undefined);
    assert.equal('outputSchema' in (tool as McpToolDescriptor), false);
  });

  it('drops a non-object outputSchema instead of propagating it', async () => {
    for (const bad of ['a string', 42, true, null, [{ type: 'object' }]]) {
      const manager = managerWithToolList([{ name: 'weird', outputSchema: bad }]);
      const [tool] = await manager.listTools(STUB_CFG);
      assert.equal(tool?.outputSchema, undefined, `expected ${JSON.stringify(bad)} to be dropped`);
    }
  });
});

// ── 4. Integration: a real fake MCP server over streamable HTTP ─────────────

interface FakeServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

/** Build one MCP server instance. Stateless mode (`sessionIdGenerator:
 *  undefined`) + a fresh instance per request, so each test can connect its own
 *  `McpManager` without tripping "Server already initialized". */
function buildMcpServerInstance(): McpSdkServer {
  const mcp = new McpSdkServer(
    { name: 'fake-weather', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_weather',
        description: 'Current weather.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
        outputSchema: OBJECT_SCHEMA,
      },
      { name: 'plain_note', description: 'Text only.', inputSchema: { type: 'object' as const } },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'plain_note') {
      return { content: [{ type: 'text' as const, text: 'just text' }] };
    }
    // BOTH a text block and a structuredContent payload, with different
    // contents: a sink payload derived from the rendered string would be
    // detectably wrong (the text is prose that is not even valid JSON).
    return {
      content: [{ type: 'text' as const, text: 'Weather: 21C in Berlin' }],
      structuredContent: { tempC: 21, city: 'Berlin' },
    };
  });
  return mcp;
}

/** Minimal in-process MCP server over streamable HTTP on an ephemeral port. */
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
  // The MCP client pools its connections and never closes them, so keep-alive
  // sockets would keep `http.close()` (and the test runner's event loop)
  // waiting forever. Track and destroy them explicitly on teardown.
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

const FAKE_CFG: McpServerConfig = {
  id: '00000000-0000-4000-8000-00000000f002',
  name: 'fake-weather',
  transport: 'http',
  endpoint: fake.url,
};

describe('structured-content sidecar over a real MCP connection (#547 W1-3)', () => {
  it('discovers the declared outputSchema', async () => {
    const manager = new McpManager();
    const tools = await manager.listTools(FAKE_CFG);
    const weather = tools.find((t) => t.name === 'get_weather');
    const note = tools.find((t) => t.name === 'plain_note');
    assert.deepEqual(weather?.outputSchema, OBJECT_SCHEMA);
    assert.equal(note?.outputSchema, undefined);
  });

  it('leaves tool_result content unchanged and hands the parsed object to the sink', async () => {
    const seen: McpSidecarPayload[] = [];
    const manager = new McpManager({ structuredSink: (p) => seen.push(p) });
    // Discovery first so the sidecar can attach the declared schema.
    await manager.listTools(FAKE_CFG);

    const result = await manager.callTool(FAKE_CFG, 'get_weather', {});

    // The model-facing string is the TEXT block, untouched by the payload.
    assert.equal(result, 'Weather: 21C in Berlin');
    assert.equal(typeof result, 'string');

    assert.equal(seen.length, 1);
    const payload = seen[0]!;
    assert.equal(payload.kind, 'structured_output');
    assert.equal(payload.serverId, FAKE_CFG.id);
    // #569 — the readable server name rides the sidecar so the receipt can
    // attribute the payload without the opaque UUID.
    assert.equal(payload.serverName, FAKE_CFG.name);
    assert.equal(payload.toolName, 'get_weather');
    // Identity, not a re-parse of the rendered string: the rendered string is
    // prose that would not parse as JSON at all.
    assert.deepEqual(payload.structured, { tempC: 21, city: 'Berlin' });
    assert.throws(() => JSON.parse(result));
    assert.deepEqual(payload.outputSchema, OBJECT_SCHEMA);
  });

  it('carries the turn id when called inside a turn', async () => {
    const seen: McpSidecarPayload[] = [];
    const manager = new McpManager({ structuredSink: (p) => seen.push(p) });
    await turnContext.run(
      { turnId: 'turn-547', turnDate: '2026-07-30', agentSlug: 'main' },
      () => manager.callTool(FAKE_CFG, 'get_weather', {}),
    );
    assert.equal(seen[0]?.turnId, 'turn-547');
  });

  it('emits nothing for a tool that returns no structuredContent', async () => {
    const seen: McpSidecarPayload[] = [];
    const manager = new McpManager({ structuredSink: (p) => seen.push(p) });
    const result = await manager.callTool(FAKE_CFG, 'plain_note', {});
    assert.equal(result, 'just text');
    assert.equal(seen.length, 0);
  });

  it('emits nothing when the call fails', async () => {
    const seen: McpSidecarPayload[] = [];
    const manager = new McpManager({ structuredSink: (p) => seen.push(p) });
    const dead: McpServerConfig = {
      id: '00000000-0000-4000-8000-00000000f003',
      name: 'dead-server',
      transport: 'http',
      endpoint: 'http://127.0.0.1:9/mcp',
    };
    const result = await manager.callTool(dead, 'get_weather', {});
    assert.ok(result.startsWith('Error:'));
    assert.equal(seen.length, 0);
  });

  it('survives a throwing sink without affecting the tool call', async () => {
    const manager = new McpManager({
      structuredSink: () => {
        throw new Error('sink exploded');
      },
    });
    const result = await manager.callTool(FAKE_CFG, 'get_weather', {});
    assert.equal(result, 'Weather: 21C in Berlin');
  });

  // ── MUTATION CHECK ────────────────────────────────────────────────────────
  // Counting sink invocations proves nothing about isolation. This proves it:
  // a hostile sink that rewrites its payload — including the nested object it
  // was handed — must not move a byte of the LLM-bound string.
  it('MUTATION CHECK: a sink that returns and writes a DIFFERENT object cannot change the LLM-bound message', async () => {
    const baseline = await new McpManager().callTool(FAKE_CFG, 'get_weather', {});

    const hostile = new McpManager({
      structuredSink: ((payload: McpSidecarPayload) => {
        // Rewrite every field of the payload we were handed...
        const mutable = payload as unknown as Record<string, unknown>;
        mutable['toolName'] = 'TAMPERED';
        mutable['serverId'] = 'TAMPERED';
        mutable['structured'] = { hijacked: true, tempC: -999 };
        mutable['outputSchema'] = { type: 'object', properties: { hijacked: {} } };
        // ...deep-mutate the nested payload object too, in case anything
        // downstream still holds the original reference...
        const structured = payload.structured as Record<string, unknown> | undefined;
        if (structured && typeof structured === 'object') {
          structured['city'] = 'TAMPERED';
          structured['tempC'] = -999;
        }
        // ...and hand back a completely different object as the return value.
        return { totally: 'different' };
      }) as unknown as (payload: McpSidecarPayload) => void,
    });
    const withHostileSink = await hostile.callTool(FAKE_CFG, 'get_weather', {});

    assert.equal(
      withHostileSink,
      baseline,
      'installing a sink changed the model-facing string — the channel is NOT out-of-band',
    );
    assert.equal(withHostileSink, 'Weather: 21C in Berlin');
    // A second call through the same (already-tampered-with) manager must be
    // just as clean — no state leaked from the sink back into the manager.
    assert.equal(await hostile.callTool(FAKE_CFG, 'get_weather', {}), baseline);
  });

  // ── PRIVACY SHIELD ────────────────────────────────────────────────────────
  // orchestrator.dispatchTool gates BOTH `captureRawToolResult` and Privacy
  // Shield masking on `typeof result === 'string'`. A non-string result would
  // silently skip masking, i.e. bypass the shield. Assert the value that
  // actually reaches that branch — the NativeToolHandler's return — is still a
  // string with a sink installed.
  it('PRIVACY SHIELD: the value reaching the orchestrator masking branch is still a string', async () => {
    const seen: McpSidecarPayload[] = [];
    const manager = new McpManager({ structuredSink: (p) => seen.push(p) });
    const handler = mcpNativeHandler(manager, FAKE_CFG, 'get_weather');
    const result: unknown = await handler({});
    assert.equal(typeof result, 'string', 'a non-string here bypasses Privacy Shield entirely');
    assert.equal(result, 'Weather: 21C in Berlin');
    // Sanity: the sidecar did fire, so this is not a vacuous pass.
    assert.equal(seen.length, 1);
  });
});
