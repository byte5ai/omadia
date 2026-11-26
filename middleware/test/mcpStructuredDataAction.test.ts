import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Both from the built entry point, like `mcpReadTool.ts`: the capture is an
// AsyncLocalStorage, and two module graphs would hold two of them.
import { McpManager, mcpNativeHandler, type McpServerConfig } from '@omadia/orchestrator';

import { createDataActionRunner } from '../src/triggers/dataActions.js';
import { mcpReadToolInvoker } from '../src/triggers/mcpReadTool.js';
import { isSandboxListenDenied } from './_helpers/listenLoopback.js';

/**
 * #547 — an MCP tool's `structuredContent` reaches the ADR-0021 data side
 * channel. A data action (`deliver_data`) builds its table from the payload the
 * server sent, even when the text mirror the model reads is prose.
 */

const ROWS = [
  { id: 1, name: 'Alpha' },
  { id: 2, name: 'Beta' },
];

async function startPeer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const msg = JSON.parse(raw) as { id?: number; method?: string };
      const reply = (payload: Record<string, unknown>): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, ...payload }));
      };
      if (msg.method === 'initialize') {
        reply({
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'structured', version: '1.0.0' },
          },
        });
        return;
      }
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      reply({
        result: {
          content: [{ type: 'text', text: 'Found two projects: Alpha and Beta.' }],
          structuredContent: { items: ROWS },
        },
      });
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('MCP structuredContent in the data side channel (#547)', () => {
  let stop: (() => Promise<void>) | undefined;
  let manager: McpManager | undefined;

  afterEach(async () => {
    await manager?.closeAll();
    await stop?.();
    manager = undefined;
    stop = undefined;
  });

  it('builds the table from structuredContent, not from the prose text mirror', async (t) => {
    let peer;
    try {
      peer = await startPeer();
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return;
      }
      throw error;
    }
    stop = peer.stop;
    manager = new McpManager();
    const cfg: McpServerConfig = {
      id: '00000000-0000-4000-8000-000000000547',
      name: 'structured',
      transport: 'http',
      endpoint: peer.url,
    };
    const handler = mcpNativeHandler(manager, cfg, 'list_projects');
    let labelled = 0;
    const invoke = mcpReadToolInvoker(handler, async () => {
      labelled += 1;
    });
    const runner = createDataActionRunner(() => new Map([['mcp__structured__list_projects', invoke]]));

    const result = await runner.run('agent', { tool: 'mcp__structured__list_projects', input: {} });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.rows, ROWS);
    assert.deepEqual(result.columns, ['id', 'name']);
    assert.equal(labelled, 1, 'the read labels the turn like any harness read');
  });

  it('control: the bare handler hands the runner prose it cannot read', async () => {
    const handler = async (): Promise<string> => 'Found two projects: Alpha and Beta.';
    const runner = createDataActionRunner(() => new Map([['t', handler]]));
    const result = await runner.run('agent', { tool: 't', input: {} });
    assert.equal(result.ok, false);
  });
});
