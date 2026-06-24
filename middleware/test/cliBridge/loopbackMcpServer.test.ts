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

describe('LoopbackMcpServer', () => {
  let server: LoopbackMcpServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('serves initialize, tools/list, and tools/call over loopback HTTP', async (t) => {
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
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
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
        Accept: 'application/json, text/event-stream',
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
    const sessionId = initializeResponse.headers.get('mcp-session-id');
    assert.ok(sessionId);
    const initializePayload = parseMcpJson(await initializeResponse.text()) as {
      result?: { protocolVersion?: string };
    };
    assert.ok(initializePayload.result);

    const initializedResponse = await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
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
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
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
    assert.ok(listPayload.result?.tools?.some((tool) => tool.name === 'ping'));

    const callResponse = await fetch(handle.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
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
        Accept: 'application/json, text/event-stream',
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
      error?: { message?: string };
      result?: unknown;
    };
    assert.equal(badBearerPayload.result, undefined);
    assert.equal(badBearerPayload.error?.message, 'Unauthorized');
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
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
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
