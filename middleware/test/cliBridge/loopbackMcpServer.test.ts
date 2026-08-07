import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { LoopbackMcpServer } from '../../packages/harness-orchestrator/src/loopbackMcpServer.js';
import type { ToolDispatchService } from '../../packages/harness-orchestrator/src/toolDispatchService.js';

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

/** True when the sandbox refuses loopback listeners, so the test self-skips. */
function isSandboxListenDenied(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM';
}

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
        result?: { tools?: Array<{ name: string }> };
      };
      assert.ok(
        listPayload.result?.tools?.some((tool) => tool.name === 'ping'),
      );

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
});
