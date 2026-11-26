import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  McpManager,
  auditCaller,
  type McpAuthProvider,
  type McpCallLogEntry,
  type McpServerConfig,
} from '../packages/harness-orchestrator/src/mcp/mcpClient.js';
import { InMemoryPendingMcpInputStore } from '../packages/harness-orchestrator/src/mcp/pendingMcpInput.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import { isSandboxListenDenied } from './_helpers/listenLoopback.js';

/**
 * ADR-0206 — `McpManager.callToolResult` reports what happened as a status,
 * so callers stop reading it off the text (#1909, #1944); a `per_user` call
 * without identity sends nothing (#1906); an unattended caller starts no
 * OAuth flow and parks no input (#1909); the audit names the real caller
 * (#1921).
 */

interface Peer {
  readonly url: string;
  readonly toolCalls: () => number;
  readonly requests: () => number;
  readonly stop: () => Promise<void>;
}

async function startPeer(): Promise<Peer> {
  let requests = 0;
  let toolCalls = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    requests += 1;
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const msg = JSON.parse(raw) as { id?: number; method?: string; params?: { name?: string } };
    const reply = (payload: Record<string, unknown>, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, ...payload }));
    };
    if (msg.method === 'initialize') {
      reply({
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'typed-outcome', version: '1.0.0' },
        },
      });
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (msg.method !== 'tools/call') {
      reply({ error: { code: -32601, message: 'Method not found' } });
      return;
    }
    toolCalls += 1;
    const tool = msg.params?.name;
    if (tool === 'error_text') {
      reply({ result: { content: [{ type: 'text', text: 'Error: no match found' }] } });
    } else if (tool === 'tool_error') {
      reply({ result: { isError: true, content: [{ type: 'text', text: 'probe tool error' }] } });
    } else if (tool === 'ask') {
      reply({
        result: {
          resultType: 'input_required',
          content: [{ type: 'text', text: 'need a customer number' }],
          inputRequests: [{ name: 'customerNumber', required: true }],
        },
      });
    } else if (tool === 'unauthorized') {
      reply({ error: { code: -32001, message: 'Unauthorized' } });
    } else {
      reply({ result: { content: [{ type: 'text', text: 'pong' }] } });
    }
  };
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
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
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    toolCalls: () => toolCalls,
    requests: () => requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function cfgFor(url: string): McpServerConfig {
  return { id: '00000000-0000-4000-8000-00000001906a', name: 'typed', transport: 'http', endpoint: url };
}

describe('McpManager typed call outcomes (ADR-0206)', () => {
  let peer: Peer | undefined;
  let manager: McpManager | undefined;

  afterEach(async () => {
    await manager?.closeAll();
    await peer?.stop();
    manager = undefined;
    peer = undefined;
  });

  async function start(t: { skip: (r: string) => void }): Promise<Peer | undefined> {
    try {
      peer = await startPeer();
      return peer;
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return undefined;
      }
      throw error;
    }
  }

  it('#1944 — a delivered result whose text starts with "Error:" is ok', async (t) => {
    const p = await start(t);
    if (!p) return;
    manager = new McpManager();
    const result = await manager.callToolResult(cfgFor(p.url), 'error_text', {});
    assert.deepEqual(result, { text: 'Error: no match found', status: 'ok' });
  });

  it('#1906 — a tool error without a token stays the tool error, not "nothing was sent"', async (t) => {
    const p = await start(t);
    if (!p) return;
    let prompts = 0;
    manager = new McpManager({
      auth: {
        getToken: async () => null,
        onAuthFailure: async () => {
          prompts += 1;
          return '🔒 connect first';
        },
      },
    });
    const result = await manager.callToolResult(cfgFor(p.url), 'tool_error', {});
    assert.equal(result.status, 'tool_error');
    assert.match(result.text, /probe tool error/);
    assert.equal(prompts, 0, 'the server answered — no auth prompt');
  });

  it('#1906 — a blocked call sends nothing and says so', async (t) => {
    const p = await start(t);
    if (!p) return;
    const audit: McpCallLogEntry[] = [];
    const auth: McpAuthProvider = {
      getToken: async () => null,
      onAuthFailure: async () => null,
      blockedReason: async () => '🔒 no identity to act as',
    };
    manager = new McpManager({ auth, onToolCall: (e) => audit.push(e) });
    const result = await manager.callToolResult(cfgFor(p.url), 'ping', {});
    assert.deepEqual(result, { text: '🔒 no identity to act as', status: 'blocked' });
    assert.equal(p.requests(), 0, 'not even a connect reached the server');
    assert.equal(audit.length, 1);
    assert.match(audit[0]!.error ?? '', /^blocked/);
  });

  it('#1909 — an unattended caller gets auth_required without an OAuth flow', async (t) => {
    const p = await start(t);
    if (!p) return;
    let prompts = 0;
    manager = new McpManager({
      auth: {
        getToken: async () => null,
        onAuthFailure: async () => {
          prompts += 1;
          return '🔒 authorize: https://auth.example/authorize';
        },
      },
    });
    const result = await manager.callToolResult(cfgFor(p.url), 'unauthorized', {}, undefined, {
      unattended: true,
    });
    assert.equal(result.status, 'auth_required');
    assert.doesNotMatch(result.text, /https:\/\//, 'no authorize URL in an unattended result');
    assert.equal(prompts, 0, 'onAuthFailure (which begins an OAuth flow) is never asked');
  });

  it('#1909 — an unattended caller is told input is required and nothing is parked', async (t) => {
    const p = await start(t);
    if (!p) return;
    const store = new InMemoryPendingMcpInputStore();
    manager = new McpManager({ pendingInput: store });
    const result = await turnContext.run(
      { turnId: '', turnDate: '2026-11-26', mcpUnattended: true },
      () => manager!.callToolResult(cfgFor(p.url), 'ask', {}),
    );
    assert.equal(result.status, 'input_required');
    assert.match(result.text, /^Error: .*needs input from a user/);
    assert.equal(store.size(), 0);
  });

  it('an attended input_required call is parked as before', async (t) => {
    const p = await start(t);
    if (!p) return;
    const store = new InMemoryPendingMcpInputStore();
    manager = new McpManager({ pendingInput: store });
    const result = await manager.callToolResult(cfgFor(p.url), 'ask', {});
    assert.equal(result.status, 'input_required');
    assert.match(result.text, /mcp_input_required/);
    assert.equal(store.size(), 1);
  });
});

describe('auditCaller (#1921)', () => {
  it('names a sub-agent, not the orchestrator that consulted it', () => {
    const c = auditCaller(
      { turnId: 't1', turnDate: 'd', agentSlug: 'fallback', mcpSubAgentName: 'helper' },
      undefined,
    );
    assert.deepEqual(c, { kind: 'subagent', agent: 'helper', turnId: 't1', principal: null });
  });

  it('treats the web chat placeholder turn id as no turn, and takes the dispatching agent', () => {
    const c = auditCaller(
      { turnId: 'http-chat-scope', turnIdIsPlaceholder: true, turnDate: 'd' },
      { agentSlug: 'fallback' },
    );
    assert.deepEqual(c, { kind: 'agent', agent: 'fallback', turnId: null, principal: null });
  });

  it('attributes a public MCP call to its API key', () => {
    const c = auditCaller(
      { turnId: 'pub-1', turnDate: 'd' },
      { principal: 'key-7', principalKind: 'api_key', agentSlug: 'fallback' },
    );
    assert.deepEqual(c, { kind: 'api_key', agent: 'fallback', turnId: 'pub-1', principal: 'apikey:key-7' });
  });

  it('keeps an explicit skill/plugin override', () => {
    const c = auditCaller(
      { turnId: 't', turnDate: 'd', mcpCallerKind: 'skill', mcpCallerId: 'sk', mcpSubAgentName: 'x' },
      undefined,
    );
    assert.equal(c.kind, 'skill');
    assert.equal(c.agent, 'sk');
  });

  it('is unattributed with no turn and no dispatch caller', () => {
    assert.deepEqual(auditCaller(undefined, undefined), {
      kind: 'unattributed',
      agent: null,
      turnId: null,
      principal: null,
    });
  });
});
