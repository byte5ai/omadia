/**
 * Issue #541 — the legacy HTTP+SSE transport is Deprecated as of MCP 2026-07-28
 * (minimum 12-month removal window). This suite pins the two halves of that:
 *
 *  1. The API surface *flags* it — `mcpNode()` derives `transportDeprecated`
 *     from `DEPRECATED_MCP_TRANSPORTS` so the web-ui can badge legacy rows
 *     without hard-coding the spec's list.
 *  2. Nothing *breaks* because of it — an existing `sse` row still gets a real
 *     `SSEClientTransport`. This is the regression guard: the unit is a
 *     discouragement, not a removal, and no runtime behaviour may change.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  DEPRECATED_MCP_TRANSPORTS,
  isDeprecatedMcpTransport,
  McpManager,
  type McpServerConfig,
  type McpServerRow,
  type McpTransportKind,
} from '@omadia/orchestrator';

import { mcpNode } from '../src/routes/agentBuilder.js';

function serverRow(transport: McpTransportKind, endpoint: string | null): McpServerRow {
  return {
    id: `00000000-0000-4000-8000-0000000000${transport === 'sse' ? 'a1' : 'a2'}`,
    name: `srv-${transport}`,
    transport,
    endpoint,
    headers: {},
    secretRef: null,
    status: 'enabled',
    lastDiscoveredAt: null,
    discoveredTools: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    source: 'manual',
    registryId: null,
    license: null,
    author: null,
    sourceUrl: null,
    privacyBypass: false,
    kgIngest: false,
    configSchema: [],
    config: {},
  };
}

/** `makeTransport` is private; the transport choice is exactly what this
 *  regression guard is about, so reach it through a narrow cast rather than
 *  standing up a live MCP server. */
function makeTransport(cfg: McpServerConfig): unknown {
  const manager = new McpManager();
  return (
    manager as unknown as { makeTransport(c: McpServerConfig, token?: string | null): unknown }
  ).makeTransport(cfg);
}

/** Same narrow cast for the v2 (`http`) factory #562 phase 2 introduced. */
function makeModernHttpTransport(cfg: McpServerConfig): unknown {
  const manager = new McpManager();
  return (
    manager as unknown as {
      makeModernHttpTransport(c: McpServerConfig, token: string | null): unknown;
    }
  ).makeModernHttpTransport(cfg, null);
}

function serverConfig(transport: McpTransportKind, endpoint: string): McpServerConfig {
  return { id: 'cfg-1', name: `srv-${transport}`, transport, endpoint };
}

describe('DEPRECATED_MCP_TRANSPORTS (#541)', () => {
  it('lists exactly the legacy HTTP+SSE transport', () => {
    assert.deepEqual([...DEPRECATED_MCP_TRANSPORTS], ['sse']);
  });

  it('classifies sse as deprecated and stdio/http as current', () => {
    assert.equal(isDeprecatedMcpTransport('sse'), true);
    assert.equal(isDeprecatedMcpTransport('http'), false);
    assert.equal(isDeprecatedMcpTransport('stdio'), false);
    // Unknown values must not be treated as deprecated.
    assert.equal(isDeprecatedMcpTransport('websocket'), false);
  });
});

describe('mcpNode transportDeprecated (#541)', () => {
  it('is true for an existing sse row', () => {
    const node = mcpNode(serverRow('sse', 'https://legacy.example/sse'));
    assert.equal(node.transportDeprecated, true);
    // Additive only: the transport itself is returned unchanged, so the row
    // keeps working and no migration/CHECK change is implied.
    assert.equal(node.transport, 'sse');
    assert.equal(node.endpoint, 'https://legacy.example/sse');
  });

  it('is false for an http row', () => {
    const node = mcpNode(serverRow('http', 'https://modern.example/mcp'));
    assert.equal(node.transportDeprecated, false);
    assert.equal(node.transport, 'http');
  });

  it('is false for a stdio row', () => {
    const node = mcpNode(serverRow('stdio', 'npx -y -- @acme/notes-mcp'));
    assert.equal(node.transportDeprecated, false);
  });
});

describe('sse regression — deprecation must not change runtime behaviour (#541)', () => {
  it('still builds an SSEClientTransport for an sse server', () => {
    const transport = makeTransport(serverConfig('sse', 'https://legacy.example/sse'));
    assert.ok(
      transport instanceof SSEClientTransport,
      'an existing sse row must still connect over SSE — the removal window is open',
    );
  });

  it('builds the v2 Streamable-HTTP transport for an http server (#562 phase 2)', () => {
    const transport = makeModernHttpTransport(serverConfig('http', 'https://modern.example/mcp'));
    assert.ok(
      transport instanceof ModernStreamableHTTPClientTransport,
      'http is the one transport that moved to @modelcontextprotocol/client@2',
    );
  });

  it('leaves sse on the v1 family — it is NOT a v2 transport (#562 phase 2)', () => {
    // Deliberate, and measured rather than assumed: `McpServer` never answers
    // `server/discover` off the HTTP edge, so an `'auto'` probe on sse can only
    // fall back to `initialize` and a pin fails outright. Porting sse would
    // swap the API and buy no protocol capability, so it stays on v1.
    const transport = makeTransport(serverConfig('sse', 'https://legacy.example/sse'));
    assert.ok(!(transport instanceof ModernStreamableHTTPClientTransport));
    assert.ok(transport instanceof SSEClientTransport);
  });
});
