#!/usr/bin/env node
/**
 * Minimal MCP stdio server, for the connection-lifetime tests (issue #563).
 *
 * Hand-rolled newline-delimited JSON-RPC instead of the MCP server SDK:
 * `@modelcontextprotocol/sdk` is a dependency of `middleware/packages/*`, not
 * of `middleware/` itself, and adding one is out of scope here.
 *
 * Contract with the tests:
 *   - `MCP_FIXTURE_MARKER` — a file this process appends `start <pid>` to on
 *     boot. One line per spawn, which is how the tests count child processes.
 *   - `MCP_FIXTURE_MODE=ok`           — `tools/call` returns "pong".
 *   - `MCP_FIXTURE_MODE=unauthorized` — `tools/call` returns a JSON-RPC error
 *     whose message reads as a 401 (so the manager's `looksUnauthorized`
 *     matches and `looksTransient` does not, i.e. no retry).
 *
 * Exits when stdin closes, which is what the SDK's stdio transport does on
 * `client.close()`.
 */
import { appendFileSync } from 'node:fs';

const marker = process.env['MCP_FIXTURE_MARKER'];
if (marker) appendFileSync(marker, `start ${process.pid}\n`);
const mode = process.env['MCP_FIXTURE_MODE'] ?? 'ok';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request) {
  const { id, method, params } = request;
  // Notifications (no id) need no reply — `notifications/initialized` lands here.
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        // Echo the client's version so we never fail negotiation on an SDK bump.
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stdio-fixture', version: '0.0.1' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    // `list <pid>` lines are the list-call counter for the tool-list cache
    // tests (#545), the same way `start <pid>` counts spawns for #563.
    if (marker) appendFileSync(marker, `list ${process.pid}\n`);
    const ttlRaw = process.env['MCP_FIXTURE_LIST_TTL_MS'];
    const scope = process.env['MCP_FIXTURE_LIST_SCOPE'];
    const response = {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'ping',
            description: 'Replies with pong.',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
        ],
        // MCP 2026-07-28 CacheableResult fields, emitted only when the test
        // asks for them — the default fixture stays a ≤2025-11-25 server
        // that sends neither.
        ...(ttlRaw !== undefined ? { ttlMs: Number(ttlRaw) } : {}),
        ...(scope ? { cacheScope: scope } : {}),
      },
    };
    // One `notifications/tools/list_changed` right after the first list, when
    // asked: lets a test observe the immediate mid-TTL invalidation without
    // needing a side channel into the child. Written in the SAME
    // `stdout.write` as the response — one pipe chunk — so the client sees
    // the coalesced delivery CI produces under load (the #545 purge-vs-prime
    // race) on every run, not just when the pipe happens to batch.
    if (process.env['MCP_FIXTURE_LIST_CHANGED'] === '1' && !globalThis.__sentListChanged) {
      globalThis.__sentListChanged = true;
      const changed = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
      process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(changed)}\n`);
      return;
    }
    send(response);
    return;
  }
  if (method === 'tools/call') {
    if (mode === 'unauthorized') {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: '401 Unauthorized: the bearer token was rejected' },
      });
      return;
    }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'pong' }] } });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.length === 0) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* ignore malformed frames — the tests never send any */
    }
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});
