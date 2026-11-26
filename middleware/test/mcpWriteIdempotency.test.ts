import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

// IMPORTANT: every symbol here comes from `packages/.../src`, never from the
// built `@omadia/orchestrator` entry point. The idempotency scope is carried by
// an `AsyncLocalStorage` instance that lives in a module — importing `McpManager`
// from `dist` while importing `ToolDispatchService` from `src` gives two separate
// module graphs, hence two separate ALS instances, and the scope silently never
// reaches the transport layer. That failure looks exactly like a broken feature.
import { LoopbackMcpServer } from '../packages/harness-orchestrator/src/loopbackMcpServer.js';
import {
  McpManager,
  mcpNativeHandler,
  type McpCallLogEntry,
  type McpServerConfig,
} from '../packages/harness-orchestrator/src/mcp/mcpClient.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { ToolDispatchService } from '../packages/harness-orchestrator/src/toolDispatchService.js';
import { ToolIdempotencyStore } from '../packages/harness-orchestrator/src/toolIdempotency.js';
import { ToolReplayLedger } from '../packages/harness-orchestrator/src/toolReplayLedger.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import type { WriteCapability } from '../packages/plugin-api/src/writeCapabilities.js';
import { isSandboxListenDenied } from './_helpers/listenLoopback.js';

/**
 * #542 prerequisite — duplicate-write protection across the MCP transport retry.
 *
 * `McpManager.callTool` retries ONCE on a transient transport failure. That is a
 * deliberate, shipped mitigation for a flaky hosted proxy and it stays. But a
 * transient failure is indistinguishable from "the server executed the write and
 * the response was lost on the way back", so for a write-capable tool the retry
 * can duplicate a mutation.
 *
 * THE MUTATION CHECK: the proxy below forwards the first `tools/call` UPSTREAM —
 * so the server really executes and really records a side effect — and only THEN
 * replaces the response with a transport error. `writes()` counts side effects
 * observed by the server itself, not mock invocations. The control test proves
 * the hazard is real (2 writes); the protected test proves the fix (1 write).
 */

const BEARER = 'loopback-secret-token';
const REMOTE_TOOL = 'create_invoice';
const LOCAL_TOOL = 'odoo_create_invoice';
const CREATE_INVOICE: readonly WriteCapability[] = [
  { dataClass: 'odoo.invoice', operation: 'create' },
];

const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

function forwardableHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase()) || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

// #1024 — the local `isSandboxListenError` this replaces ignored
// `OMADIA_EXPECT_LOOPBACK`, so a listener-denied runner skipped the
// duplicate-write protection proof and still reported success.

function serverConfig(url: string): McpServerConfig {
  return {
    id: '00000000-0000-4000-8000-0000000wr1te'.replace('wr1te', 'c0ded'),
    name: 'loopback-write',
    transport: 'http',
    endpoint: url,
    headers: { Authorization: `Bearer ${BEARER}` },
  };
}

interface LosingProxy {
  readonly url: string;
  readonly toolCallCount: () => number;
  readonly stop: () => Promise<void>;
}

/**
 * Proxy that loses the RESPONSE to the first `tools/call` after the upstream
 * server already handled it. This is the dangerous shape the retry cannot
 * distinguish: the write happened, the caller only saw a dropped connection.
 *
 * The answer is a JSON-RPC error, so the connection itself stays healthy and a
 * re-send travels over the same session to the same upstream (ADR-0205: only a
 * connection that is really gone is dropped).
 */
async function startLosingProxy(target: string): Promise<LosingProxy> {
  let toolCalls = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    }
    const body = Buffer.concat(chunks);
    const text = body.toString('utf8');
    const isToolCall = req.method === 'POST' && text.includes('"tools/call"');
    if (isToolCall) toolCalls += 1;
    const loseResponse = isToolCall && toolCalls === 1;

    const upstream = await fetch(target, {
      method: req.method ?? 'GET',
      headers: forwardableHeaders(req.headers),
      ...(body.length > 0 ? { body } : {}),
    });
    // Drain upstream so the server completes the call (and its side effect).
    const upstreamText = await upstream.text();

    if (loseResponse) {
      // The write DID happen upstream. Now drop the answer on the floor and hand
      // back the transport error a flaky hosted proxy actually returns.
      const id = (() => {
        try {
          return (JSON.parse(text) as { id?: unknown }).id ?? null;
        } catch {
          return null;
        }
      })();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'Connection closed' },
        }),
      );
      return;
    }

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders[key] = value;
    });
    res.writeHead(upstream.status, responseHeaders);
    res.end(upstreamText);
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    toolCallCount: () => toolCalls,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** ADR-0205 — what discovery records when the server annotates the tool with
 *  `idempotentHint: true`; the only thing that lets an answerless call be
 *  re-sent. */
function declareResendSafe(mgr: McpManager, cfg: McpServerConfig): void {
  mgr.rememberToolSchema(cfg.id, { name: REMOTE_TOOL, idempotentHint: true });
}

describe('write-capable MCP tool — duplicate-write protection (#542 prerequisite)', () => {
  const servers: LoopbackMcpServer[] = [];
  let proxy: LosingProxy | undefined;
  let manager: McpManager | undefined;

  afterEach(async () => {
    await manager?.closeAll();
    await proxy?.stop();
    for (const s of servers.splice(0)) await s.stop();
    manager = undefined;
    proxy = undefined;
  });

  /**
   * A real `LoopbackMcpServer` whose tool records a side effect per execution.
   * `writes` is shared across instances so a retry landing on the second server
   * still increments the SAME counter — that is what makes it a true count of
   * effects rather than a per-connection statistic.
   */
  async function startWriteServer(
    t: { skip: (reason: string) => void },
    writes: string[],
  ): Promise<string | undefined> {
    const remote = new NativeToolRegistry();
    remote.register(REMOTE_TOOL, {
      handler: async (input) => {
        writes.push(JSON.stringify(input));
        return `invoice #${String(writes.length)} created`;
      },
      spec: {
        name: REMOTE_TOOL,
        description: 'creates an invoice (side effect)',
        input_schema: { type: 'object', properties: { amount: { type: 'number' } } },
      },
      domain: 'test.odoo',
    });
    const server = new LoopbackMcpServer({
      dispatch: new ToolDispatchService({
        nativeTools: remote,
        domainTools: [],
      }),
      bearer: BEARER,
      tools: [
        {
          name: REMOTE_TOOL,
          description: 'creates an invoice (side effect)',
          input_schema: {
            type: 'object',
            properties: { amount: { type: 'number' } },
          },
        },
      ],
    });
    try {
      const handle = await server.start();
      servers.push(server);
      return handle.url;
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return undefined;
      }
      throw error;
    }
  }

  /** Local dispatcher whose write tool forwards to the remote MCP server. */
  function localDispatcher(
    mgr: McpManager,
    cfg: McpServerConfig,
    options: { readonly declareWrite: boolean; readonly store?: ToolIdempotencyStore },
  ): ToolDispatchService {
    const nativeTools = new NativeToolRegistry();
    nativeTools.register(LOCAL_TOOL, {
      handler: mcpNativeHandler(mgr, cfg, REMOTE_TOOL),
      spec: {
        name: LOCAL_TOOL,
        description: 'creates an invoice',
        input_schema: { type: 'object', properties: { amount: { type: 'number' } } },
      },
      domain: 'test.odoo',
      ...(options.declareWrite ? { writeCapabilities: CREATE_INVOICE } : {}),
    });
    return new ToolDispatchService({
      nativeTools,
      domainTools: [],
      ...(options.store !== undefined ? { idempotency: options.store } : {}),
    });
  }

  it('CONTROL — a tool its server declares idempotent is re-sent after the lost response', async (t) => {
    const writes: string[] = [];
    const first = await startWriteServer(t, writes);
    if (!first) return;
    proxy = await startLosingProxy(first);

    manager = new McpManager();
    const cfg = serverConfig(proxy.url);
    declareResendSafe(manager, cfg);
    const dispatcher = localDispatcher(manager, cfg, { declareWrite: true });

    await dispatcher.dispatch(LOCAL_TOOL, { amount: 100 });

    // The hazard, demonstrated rather than asserted in prose: the server
    // executed the call, the response was lost, the re-send executed it AGAIN.
    // ADR-0205 accepts that only because the server declared it harmless.
    assert.equal(proxy.toolCallCount(), 2, 'the declared tool must still be re-sent');
    assert.equal(writes.length, 2, 'baseline: the call really does run twice when re-sent');
  });

  it('#1904 — an undeclared tool is sent once and the outcome is reported as unknown', async (t) => {
    const writes: string[] = [];
    const first = await startWriteServer(t, writes);
    if (!first) return;
    proxy = await startLosingProxy(first);

    const audit: McpCallLogEntry[] = [];
    manager = new McpManager({ onToolCall: (e) => audit.push(e) });
    const dispatcher = localDispatcher(manager, serverConfig(proxy.url), {
      declareWrite: true,
    });

    const result = await dispatcher.dispatch(LOCAL_TOOL, { amount: 100 });

    assert.equal(proxy.toolCallCount(), 1, 'a write without a declaration must not be re-sent');
    assert.equal(writes.length, 1);
    assert.match(result.content, /^Error: outcome unknown/);
    assert.match(result.content, /check the result/);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.ok, false);
    assert.match(audit[0]!.error ?? '', /^outcome_unknown:/);
  });

  it('#1904 — every attempt of a re-sent call gets its own audit row', async (t) => {
    const writes: string[] = [];
    const first = await startWriteServer(t, writes);
    if (!first) return;
    proxy = await startLosingProxy(first);

    const audit: McpCallLogEntry[] = [];
    manager = new McpManager({ onToolCall: (e) => audit.push(e) });
    const cfg = serverConfig(proxy.url);
    declareResendSafe(manager, cfg);

    await manager.callTool(cfg, REMOTE_TOOL, { amount: 1 });

    assert.deepEqual(
      audit.map((e) => e.outcome),
      ['fail', 'ok'],
      'the first, lost attempt must be visible next to the successful re-send',
    );
    assert.match(audit[0]!.error ?? '', /sent again/);
  });

  it('executes the write EXACTLY ONCE under an idempotency key, despite the lost response', async (t) => {
    const writes: string[] = [];
    const first = await startWriteServer(t, writes);
    if (!first) return;
    proxy = await startLosingProxy(first);

    manager = new McpManager();
    const dispatcher = localDispatcher(manager, serverConfig(proxy.url), {
      declareWrite: true,
      store: new ToolIdempotencyStore(),
    });

    const result = await dispatcher.dispatch(
      LOCAL_TOOL,
      { amount: 100 },
      { idempotencyKey: 'req-invoice-1' },
    );

    // THE load-bearing assertion: one real side effect on the server.
    assert.equal(
      writes.length,
      1,
      'the write executed more than once — duplicate customer data is exactly what this prevents',
    );
    assert.equal(
      proxy.toolCallCount(),
      1,
      'a write-capable call under an exactly-once scope must make a single attempt',
    );
    // The caller still learns it failed — at-most-once means the caller may have
    // to ask again with the same key, not that failure is hidden. `McpManager`
    // never throws, it returns the failure as `Error: …` TEXT, so this surfaces as
    // content rather than an `isError` flag.
    assert.match(
      result.content,
      /Error:/,
      'suppressing the retry must not silently report success',
    );
  });

  it('MUTATION CHECK: the retry SHARES the absolute MCP budget instead of doubling it', async (t) => {
    // W4. The retry used to start with a FRESH `maxTotalTimeout`, so one
    // `callTool` was worth up to 2 x the absolute ceiling of wall clock — 360s
    // against a 240s outer dispatch deadline, i.e. the very inversion W3-A
    // removed, re-created by a knob nobody counted in the invariant.
    //
    // Driven through the real knob rather than a stub: with the ceiling set below
    // the retry's minimum-remaining floor, the budget is provably spent after
    // attempt 1 no matter how fast the machine is, so no second attempt may
    // start. The CONTROL test above proves this same proxy produces TWO attempts
    // when the budget allows it, so a green result here is the budget doing the
    // work — not the retry having quietly disappeared.
    const previousCeiling = process.env['OMADIA_MCP_CALL_MAX_TOTAL_TIMEOUT_MS'];
    process.env['OMADIA_MCP_CALL_MAX_TOTAL_TIMEOUT_MS'] = '900';
    try {
      const writes: string[] = [];
      const first = await startWriteServer(t, writes);
      if (!first) return;
      proxy = await startLosingProxy(first);

      manager = new McpManager();
      // No idempotency key: the `exactlyOnce` clamp is NOT what suppresses the
      // retry here — this is a plain read-shaped dispatch of a declared tool,
      // exactly the CONTROL configuration that produced two attempts.
      const cfg = serverConfig(proxy.url);
      declareResendSafe(manager, cfg);
      const dispatcher = localDispatcher(manager, cfg, { declareWrite: false });

      const result = await dispatcher.dispatch(LOCAL_TOOL, { amount: 100 });

      assert.equal(
        proxy.toolCallCount(),
        1,
        'attempt 2 started with a fresh allowance — the absolute ceiling is not absolute',
      );
      assert.match(result.content, /Error:/, 'the failure must still be reported');
    } finally {
      if (previousCeiling === undefined) {
        delete process.env['OMADIA_MCP_CALL_MAX_TOTAL_TIMEOUT_MS'];
      } else {
        process.env['OMADIA_MCP_CALL_MAX_TOTAL_TIMEOUT_MS'] = previousCeiling;
      }
    }
  });

  it('a READ tool keeps the once-retry mitigation intact', async (t) => {
    const writes: string[] = [];
    const first = await startWriteServer(t, writes);
    if (!first) return;
    proxy = await startLosingProxy(first);

    manager = new McpManager();
    // No `writeCapabilities` ⇒ no exactly-once scope, and the server declares
    // the tool read-only, so the flaky-proxy mitigation applies even with a key
    // present. Removing the retry outright would regress this.
    const cfg = serverConfig(proxy.url);
    manager.rememberToolSchema(cfg.id, { name: REMOTE_TOOL, readOnlyHint: true });
    const dispatcher = localDispatcher(manager, cfg, {
      declareWrite: false,
      store: new ToolIdempotencyStore(),
    });

    const result = await dispatcher.dispatch(
      LOCAL_TOOL,
      { amount: 100 },
      { idempotencyKey: 'req-read-1' },
    );

    assert.equal(proxy.toolCallCount(), 2, 'the read must still be retried once');
    assert.equal(result.isError, undefined, 'and the retry must succeed');
    assert.match(result.content, /invoice #2 created/);
  });

  it('a duplicate dispatch under the SAME key does not reach the server again', async (t) => {
    const writes: string[] = [];
    const url = await startWriteServer(t, writes);
    if (!url) return;

    manager = new McpManager();
    const dispatcher = localDispatcher(manager, serverConfig(url), {
      declareWrite: true,
      store: new ToolIdempotencyStore(),
    });

    const a = await dispatcher.dispatch(
      LOCAL_TOOL,
      { amount: 100 },
      { idempotencyKey: 'req-invoice-2' },
    );
    const b = await dispatcher.dispatch(
      LOCAL_TOOL,
      { amount: 100 },
      { idempotencyKey: 'req-invoice-2' },
    );

    assert.equal(writes.length, 1, 'the caller retry must not produce a second invoice');
    assert.equal(a.content, b.content, 'the retry must receive the original result');
    assert.match(a.content, /invoice #1 created/);
  });

  /**
   * The chat path has no idempotency key. Inside a request an answer verifier
   * may re-enter, the request's replay ledger holds every write to ONE
   * execution and counts every MCP tool as a write, so the seams send each
   * call once while that ledger is bound (`runHandlerAtMostOnce`): a lost
   * response must not be re-sent below the ledger, which sees one call.
   */
  async function dispatchInTurn(
    t: { skip: (reason: string) => void },
    ledger: ToolReplayLedger,
  ): Promise<{ writes: string[]; content: string } | undefined> {
    const writes: string[] = [];
    const first = await startWriteServer(t, writes);
    if (!first) return undefined;
    proxy = await startLosingProxy(first);

    manager = new McpManager();
    const cfg = serverConfig(proxy.url);
    // Declared, so only the ledger can be what suppresses the re-send.
    declareResendSafe(manager, cfg);
    const dispatcher = localDispatcher(manager, cfg, { declareWrite: true });
    const result = await turnContext.run(
      { turnId: 'turn-write-once', turnDate: '2026-10-01', toolReplayLedger: ledger },
      () => dispatcher.dispatch(LOCAL_TOOL, { amount: 100 }),
    );
    return { writes, content: result.content };
  }

  it('MUTATION CHECK: inside a request with a bound replay ledger, the lost response is not re-sent', async (t) => {
    const outcome = await dispatchInTurn(t, new ToolReplayLedger());
    if (!outcome) return;

    assert.equal(outcome.writes.length, 1, 'the write ran twice inside one request');
    assert.equal(proxy?.toolCallCount(), 1, 'the transport re-sent the call');
    assert.match(outcome.content, /Error:/, 'the failure is still reported');
  });

  it('control: a turn without a bound request ledger keeps the once-retry', async (t) => {
    const outcome = await dispatchInTurn(t, new ToolReplayLedger({ retainResults: false }));
    if (!outcome) return;

    assert.equal(proxy?.toolCallCount(), 2, 'the turn-local ledger changed the transport retry');
    assert.equal(outcome.writes.length, 2);
  });
});
