import { strict as assert } from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, it } from 'node:test';

import { LoopbackMcpServer } from '../../packages/harness-orchestrator/src/loopbackMcpServer.js';
import type { ToolDispatchService } from '../../packages/harness-orchestrator/src/toolDispatchService.js';
import { isSandboxListenDenied } from '../_helpers/listenLoopback.js';

function parseMcpJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    return JSON.parse(trimmed);
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);

  return JSON.parse(dataLines.join('\n'));
}

const MCP_ACCEPT = 'application/json, text/event-stream';

// #1017 gave this file's local guard the `OMADIA_EXPECT_LOOPBACK` behaviour;
// #1024 moved it to `test/_helpers/listenLoopback.ts` so the six other sites
// that had grown their own copy share it instead of diverging.

describe('LoopbackMcpServer', () => {
  let server: LoopbackMcpServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  /**
   * W1-2 — the loopback transport is stateless (`sessionIdGenerator:
   * undefined`), so the wire contract must hold both for a client that
   * replays whatever session id the server hands out and for one that never
   * sends the header at all. Before the stateless switch the second variant
   * failed with HTTP 400 "Mcp-Session-Id header is required".
   */
  for (const variant of [
    {
      label: 'replaying the session id when the server issues one',
      replaySession: true,
    },
    { label: 'never sending a session header', replaySession: false },
  ] as const) {
    it(`serves initialize, tools/list, and tools/call over loopback HTTP — ${variant.label}`, async (t) => {
      const seenCalls: Array<{ name: string; input: unknown }> = [];
      const fakeDispatch = {
        async dispatch(name: string, input: unknown) {
          seenCalls.push({ name, input });
          return { content: `dispatch:${name}:${JSON.stringify(input)}` };
        },
      } as unknown as ToolDispatchService;

      server = new LoopbackMcpServer({
        dispatch: fakeDispatch,
        bearer: 'secret-token',
        tools: [
          {
            name: 'ping',
            description: 'p',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      });

      let handle: Awaited<ReturnType<typeof server.start>>;
      try {
        handle = await server.start();
      } catch (error) {
        if (isSandboxListenDenied(error)) {
          t.skip('sandbox blocks loopback listeners on 127.0.0.1');
          return;
        }
        throw error;
      }

      const initializeResponse = await fetch(handle.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${handle.bearer}`,
          'Content-Type': 'application/json',
          Accept: MCP_ACCEPT,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '0' },
          },
          id: 1,
        }),
      });
      assert.equal(initializeResponse.status, 200);
      const issuedSessionId = initializeResponse.headers.get('mcp-session-id');
      const initializePayload = parseMcpJson(
        await initializeResponse.text(),
      ) as {
        result?: { protocolVersion?: string };
      };
      assert.ok(initializePayload.result);

      // A stateless transport issues no session id at all. Only the replaying
      // variant forwards one, and only when the server actually handed it out.
      const sessionHeaders: Record<string, string> =
        variant.replaySession && issuedSessionId
          ? { 'mcp-session-id': issuedSessionId }
          : {};

      const initializedResponse = await fetch(handle.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${handle.bearer}`,
          'Content-Type': 'application/json',
          Accept: MCP_ACCEPT,
          ...sessionHeaders,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      });
      assert.equal(initializedResponse.status, 202);

      const listResponse = await fetch(handle.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${handle.bearer}`,
          'Content-Type': 'application/json',
          Accept: MCP_ACCEPT,
          ...sessionHeaders,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {},
          id: 2,
        }),
      });
      assert.equal(listResponse.status, 200);
      const listPayload = parseMcpJson(await listResponse.text()) as {
        result?: {
          tools?: Array<{ name: string }>;
          ttlMs?: unknown;
          cacheScope?: unknown;
        };
      };
      assert.ok(
        listPayload.result?.tools?.some((tool) => tool.name === 'ping'),
      );
      // #545 — MCP 2026-07-28 CacheableResult: frozen per-turn list, one
      // bearer, no per-principal filtering ⇒ generous TTL, public scope.
      assert.equal(listPayload.result?.ttlMs, 300_000);
      assert.equal(listPayload.result?.cacheScope, 'public');

      const callResponse = await fetch(handle.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${handle.bearer}`,
          'Content-Type': 'application/json',
          Accept: MCP_ACCEPT,
          ...sessionHeaders,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'ping', arguments: {} },
          id: 3,
        }),
      });
      assert.equal(callResponse.status, 200);
      const callPayload = parseMcpJson(await callResponse.text()) as {
        result?: {
          content?: Array<{ type: string; text: string }>;
          isError?: boolean;
        };
      };
      assert.equal(callPayload.result?.content?.[0]?.text, 'dispatch:ping:{}');
      assert.equal(callPayload.result?.isError, undefined);
      assert.deepEqual(seenCalls, [{ name: 'ping', input: {} }]);

      const badBearerResponse = await fetch(handle.url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer wrong',
          'Content-Type': 'application/json',
          Accept: MCP_ACCEPT,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {},
          id: 4,
        }),
      });
      assert.equal(badBearerResponse.status, 401);
      const badBearerPayload = parseMcpJson(await badBearerResponse.text()) as {
        error?: { code?: number; message?: string };
        result?: unknown;
      };
      assert.equal(badBearerPayload.result, undefined);
      assert.equal(badBearerPayload.error?.code, -32001);
      assert.equal(badBearerPayload.error?.message, 'Unauthorized');
    });
  }

  /**
   * W1-2 criterion — the stateless transport must serve a cold client that
   * skips the handshake entirely. Under the previous stateful transport both
   * calls below were rejected before ever reaching a request handler.
   */
  it('serves tools/list and tools/call with no prior initialize and no session header', async (t) => {
    const seenCalls: Array<{ name: string; input: unknown }> = [];
    const fakeDispatch = {
      async dispatch(name: string, input: unknown) {
        seenCalls.push({ name, input });
        return { content: `dispatch:${name}:${JSON.stringify(input)}` };
      },
    } as unknown as ToolDispatchService;

    server = new LoopbackMcpServer({
      dispatch: fakeDispatch,
      bearer: 'secret-token',
      tools: [
        {
          name: 'ping',
          description: 'p',
          input_schema: { type: 'object', properties: {} },
        },
      ],
    });

    let handle: Awaited<ReturnType<typeof server.start>>;
    try {
      handle = await server.start();
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return;
      }
      throw error;
    }

    const listResponse = await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 1,
      }),
    });
    assert.equal(listResponse.status, 200);
    const listPayload = parseMcpJson(await listResponse.text()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    assert.deepEqual(
      listPayload.result?.tools?.map((tool) => tool.name),
      ['ping'],
    );

    const callResponse = await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'ping', arguments: { a: 1 } },
        id: 2,
      }),
    });
    assert.equal(callResponse.status, 200);
    const callPayload = parseMcpJson(await callResponse.text()) as {
      result?: { content?: Array<{ type: string; text: string }> };
    };
    assert.equal(
      callPayload.result?.content?.[0]?.text,
      'dispatch:ping:{"a":1}',
    );
    assert.deepEqual(seenCalls, [{ name: 'ping', input: { a: 1 } }]);
  });

  /** W0-3 — the loopback tool list is advertised name-sorted regardless of
   *  the order the dispatch service handed the specs over in. */
  it('advertises tools sorted by name', async (t) => {
    const fakeDispatch = {
      async dispatch() {
        return { content: 'ok' };
      },
    } as unknown as ToolDispatchService;

    server = new LoopbackMcpServer({
      dispatch: fakeDispatch,
      bearer: 'secret-token',
      tools: ['zebra_tool', 'alpha_tool', 'mango_tool'].map((name) => ({
        name,
        description: name,
        input_schema: { type: 'object', properties: {} },
      })),
    });

    let handle: Awaited<ReturnType<typeof server.start>>;
    try {
      handle = await server.start();
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return;
      }
      throw error;
    }

    const listResponse = await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 1,
      }),
    });
    assert.equal(listResponse.status, 200);
    const listPayload = parseMcpJson(await listResponse.text()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    assert.deepEqual(
      listPayload.result?.tools?.map((tool) => tool.name),
      ['alpha_tool', 'mango_tool', 'zebra_tool'],
    );
  });

  /**
   * W1-2 — the optional GET standalone SSE stream is declined with 405 (which
   * the MCP spec allows). Without this the per-request transport would leak:
   * a GET stream never ends, so its request scope never tears down.
   */
  it('declines the standalone SSE stream with HTTP 405', async (t) => {
    const fakeDispatch = {
      async dispatch() {
        return { content: 'ok' };
      },
    } as unknown as ToolDispatchService;

    server = new LoopbackMcpServer({
      dispatch: fakeDispatch,
      bearer: 'secret-token',
      tools: [],
    });

    let handle: Awaited<ReturnType<typeof server.start>>;
    try {
      handle = await server.start();
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return;
      }
      throw error;
    }

    const response = await fetch(handle.url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        Accept: 'text/event-stream',
      },
      // A hanging SSE stream would blow this, which is the regression guard.
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');

    // Auth is still checked before the method gate.
    const unauthorized = await fetch(handle.url, {
      method: 'GET',
      headers: { Authorization: 'Bearer wrong' },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(unauthorized.status, 401);
    const payload = parseMcpJson(await unauthorized.text()) as {
      error?: { code?: number };
    };
    assert.equal(payload.error?.code, -32001);
  });

  it('rejects oversized POST bodies with HTTP 413', async (t) => {
    const fakeDispatch = {
      async dispatch() {
        return { content: 'ok' };
      },
    } as unknown as ToolDispatchService;

    server = new LoopbackMcpServer({
      dispatch: fakeDispatch,
      bearer: 'secret-token',
      tools: [],
    });

    let handle: Awaited<ReturnType<typeof server.start>>;
    try {
      handle = await server.start();
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return;
      }
      throw error;
    }

    const tooLargeBody = JSON.stringify({
      payload: 'x'.repeat(8 * 1024 * 1024),
    });

    const response = await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
      },
      body: tooLargeBody,
    });

    assert.equal(response.status, 413);
    const payload = parseMcpJson(await response.text()) as {
      error?: { code?: number; message?: string };
    };
    assert.equal(payload.error?.code, 413);
    assert.equal(payload.error?.message, 'Payload Too Large');
  });

  /**
   * OM-82 (#993) — on the subscription path a tool call arrives as an HTTP
   * request from the external `claude` process, i.e. in a fresh async context.
   * Every AsyncLocalStorage the channel turn set (routineTurnContext,
   * privacyHandle, toolIdempotency, ...) was undefined inside `dispatch()`, so
   * `manage_routine` answered "no user context" to a user who was in a channel.
   * The server must capture the turn's async context when it is created and
   * run each dispatch inside it.
   */
  it('runs tools/call inside the async context the server was created in', async (t) => {
    const turnStore = new AsyncLocalStorage<{ readonly tenant: string; readonly userId: string }>();
    const fakeDispatch = {
      async dispatch(name: string) {
        const turn = turnStore.getStore();
        return { content: `${name}:${turn ? `${turn.tenant}/${turn.userId}` : 'no-context'}` };
      },
    } as unknown as ToolDispatchService;

    // Construct inside the turn scope, exactly as CliChatAgent.runLifecycle does.
    server = turnStore.run({ tenant: 'te-printline', userId: 'silvio' }, () =>
      new LoopbackMcpServer({
        dispatch: fakeDispatch,
        bearer: 'secret-token',
        tools: [{ name: 'manage_routine', description: 'r', input_schema: { type: 'object', properties: {} } }],
      }),
    );

    let handle: Awaited<ReturnType<typeof server.start>>;
    try {
      handle = await server.start();
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners');
        return;
      }
      throw error;
    }

    // The call comes from outside the turn scope (a different async context).
    assert.equal(turnStore.getStore(), undefined);
    const callResponse = await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'manage_routine', arguments: { action: 'list' } },
        id: 7,
      }),
    });
    assert.equal(callResponse.status, 200);
    const payload = parseMcpJson(await callResponse.text()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    assert.equal(payload.result?.content?.[0]?.text, 'manage_routine:te-printline/silvio');
  });

  /**
   * #1016 — the context must come from where the caller captured it, not from
   * wherever this server happened to be constructed. `CliChatAgent` builds the
   * server inside an async generator, whose body runs at first iteration, so
   * the construction-time snapshot can belong to whoever iterated.
   */
  it('prefers the caller-captured async context over its own construction scope', async (t) => {
    const turnStore = new AsyncLocalStorage<string>();
    const fakeDispatch = {
      async dispatch(name: string) {
        return { content: `${name}:${turnStore.getStore() ?? 'no-context'}` };
      },
    } as unknown as ToolDispatchService;

    // Capture in the CALLER's scope...
    const captured = turnStore.run('caller-scope', () => AsyncLocalStorage.snapshot());

    // ...then construct in a DIFFERENT scope, as a lazily-started generator would.
    server = turnStore.run('generator-scope', () =>
      new LoopbackMcpServer({
        dispatch: fakeDispatch,
        bearer: 'secret-token',
        tools: [{ name: 'ping', description: 'p', input_schema: { type: 'object', properties: {} } }],
        runInTurnContext: captured,
      }),
    );

    let handle: Awaited<ReturnType<typeof server.start>>;
    try {
      handle = await server.start();
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners');
        return;
      }
      throw error;
    }

    const response = await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'ping', arguments: {} },
        id: 11,
      }),
    });
    const payload = parseMcpJson(await response.text()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    assert.equal(payload.result?.content?.[0]?.text, 'ping:caller-scope');
  });

  /**
   * #1016 — restoring a context is not the same as trusting it.
   * `routineTurnContext` is entered with `enterWith`, which has no scope exit,
   * so a stale async chain can carry an older turn's identity. Before this
   * guard the failure mode was "acts as the previous principal"; now it is a
   * refusal.
   */
  it('refuses a dispatch when the restored context is not this turn', async (t) => {
    let dispatched = 0;
    const fakeDispatch = {
      async dispatch(name: string) {
        dispatched += 1;
        return { content: `dispatched:${name}` };
      },
    } as unknown as ToolDispatchService;

    server = new LoopbackMcpServer({
      dispatch: fakeDispatch,
      bearer: 'secret-token',
      tools: [{ name: 'manage_routine', description: 'r', input_schema: { type: 'object', properties: {} } }],
      assertTurnOwner: () => {
        throw new Error('turn owner mismatch: context belongs to another turn');
      },
    });

    let handle: Awaited<ReturnType<typeof server.start>>;
    try {
      handle = await server.start();
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners');
        return;
      }
      throw error;
    }

    const response = await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'manage_routine', arguments: { action: 'create' } },
        id: 12,
      }),
    });

    const payload = parseMcpJson(await response.text()) as {
      error?: { message?: string };
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    const surfaced = payload.error?.message ?? payload.result?.content?.[0]?.text ?? '';
    assert.match(surfaced, /turn owner mismatch/);
    assert.equal(dispatched, 0, 'the tool must not run when the owner check fails');
  });

  it('dispatches normally when the owner check passes', async (t) => {
    const fakeDispatch = {
      async dispatch(name: string) {
        return { content: `dispatched:${name}` };
      },
    } as unknown as ToolDispatchService;

    let checks = 0;
    server = new LoopbackMcpServer({
      dispatch: fakeDispatch,
      bearer: 'secret-token',
      tools: [{ name: 'manage_routine', description: 'r', input_schema: { type: 'object', properties: {} } }],
      assertTurnOwner: () => {
        checks += 1;
      },
    });

    let handle: Awaited<ReturnType<typeof server.start>>;
    try {
      handle = await server.start();
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners');
        return;
      }
      throw error;
    }

    const response = await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'manage_routine', arguments: {} },
        id: 13,
      }),
    });

    const payload = parseMcpJson(await response.text()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    assert.equal(payload.result?.content?.[0]?.text, 'dispatched:manage_routine');
    assert.equal(checks, 1, 'the owner check must run on every dispatch');
  });

  /**
   * #1015 — `tools/call` used to dispatch any name the client sent. The
   * dispatchable set is wider than the advertised one: handler-only
   * registrations stay dispatchable but unadvertised, and readiness-gated
   * tools are filtered out of the advertised list. Since the CLI runs with
   * `--allowedTools mcp__omadia__*`, which pre-approves the whole namespace,
   * this handler is the only place that can tell the two apart.
   */
  it('refuses a tool it never advertised', async (t) => {
    let dispatched = 0;
    const fakeDispatch = {
      async dispatch(name: string) {
        dispatched += 1;
        return { content: `dispatched:${name}` };
      },
    } as unknown as ToolDispatchService;

    server = new LoopbackMcpServer({
      dispatch: fakeDispatch,
      bearer: 'secret-token',
      // Advertises `ping` only. `secret_admin_tool` is dispatchable in the
      // service but deliberately kept off the wire.
      tools: [{ name: 'ping', description: 'p', input_schema: { type: 'object', properties: {} } }],
    });

    let handle: Awaited<ReturnType<typeof server.start>>;
    try {
      handle = await server.start();
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners');
        return;
      }
      throw error;
    }

    const response = await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'secret_admin_tool', arguments: {} },
        id: 14,
      }),
    });

    const payload = parseMcpJson(await response.text()) as {
      error?: { code?: number; message?: string };
      result?: { content?: Array<{ text?: string }> };
    };
    const surfaced = payload.error?.message ?? payload.result?.content?.[0]?.text ?? '';
    assert.match(surfaced, /not advertised/);
    assert.equal(dispatched, 0, 'an unadvertised tool must never reach dispatch');
  });

  /**
   * #1015 — `stop()` must not be able to hang a turn. It used to await
   * `close()`, which waits for live connections; the CLI child holds a
   * keep-alive socket, so on an abort path that await could block forever and
   * the caller's kill escalation never ran.
   */
  it('stops in bounded time with a live keep-alive connection open', async (t) => {
    const fakeDispatch = {
      async dispatch(name: string) {
        return { content: `dispatched:${name}` };
      },
    } as unknown as ToolDispatchService;

    const local = new LoopbackMcpServer({
      dispatch: fakeDispatch,
      bearer: 'secret-token',
      tools: [{ name: 'ping', description: 'p', input_schema: { type: 'object', properties: {} } }],
    });

    let handle: Awaited<ReturnType<typeof local.start>>;
    try {
      handle = await local.start();
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners');
        return;
      }
      throw error;
    }

    // A keep-alive agent holds the socket open after the response, which is
    // what the CLI child does between tool calls.
    const keepAlive = new (await import('node:http')).Agent({ keepAlive: true });
    await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Connection: 'keep-alive',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'ping', arguments: {} },
        id: 15,
      }),
    });

    const startedAt = Date.now();
    await local.stop();
    const elapsed = Date.now() - startedAt;
    keepAlive.destroy();

    // The bound in `stop()` is 2s; anything near it means the race saved us
    // rather than `closeAllConnections()`, and anything above it is a hang.
    assert.ok(elapsed < 2_500, `stop() took ${elapsed}ms`);
  });
});
