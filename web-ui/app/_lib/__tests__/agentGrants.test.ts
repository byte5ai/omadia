import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getAgentGrants,
  getAgentPlugins,
  parseOperatorAgentErrorCode,
  toggleAgentPlugin,
  type AgentGrantsDto,
} from '../agents';
import {
  parseMcpGrantErrorCode,
  replaceMcpToolAllowlist,
  type McpGrantMatrixRow,
  type McpServerNode,
  type McpToolAllowlistResult,
  type ToolGrantNode,
} from '../agentBuilder';
import { ApiError } from '../api';

/**
 * W0c (#861/#862) — the _lib layer for the per-agent grant/assignment UI.
 *
 * These callers mirror the REST contracts of `routes/operatorAgents.ts`
 * (per-agent grants read, plugin toggle) and `routes/agentBuilder.ts`
 * (allowlist replace + delegation surfacing) in the middleware. The tests pin
 * the URL/method/body wire shape and the error-code extraction the page units
 * build their i18n mapping on — never the middleware behavior itself (that
 * lives in middleware/test/).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lastCall(mock: ReturnType<typeof vi.fn>): {
  url: string;
  init: RequestInit;
} {
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAgentGrants (#861)', () => {
  it('GETs the per-agent grants read model and surfaces the grant epoch', async () => {
    const payload: AgentGrantsDto = {
      slug: 'hr-agent',
      grant_epoch: '2026-08-25 17:00:00.000000+00',
      tool_grants: [
        {
          id: 'g1',
          tool_kind: 'mcp',
          tool_ref: 'mcp:odoo:read_employees',
          sub_agent_id: null,
          mcp_server_id: 's1',
          server_name: 'odoo',
          grant_epoch: '2026-08-25 17:00:00.000000+00',
          created_at: '2026-08-20T09:00:00.000Z',
        },
        {
          id: 'g2',
          tool_kind: 'native',
          tool_ref: 'web_search',
          sub_agent_id: null,
          mcp_server_id: null,
          server_name: null,
          grant_epoch: null,
          created_at: '2026-08-20T09:00:00.000Z',
        },
      ],
      plugin_mcp_grants: [
        {
          plugin_id: '@omadia/odoo',
          mcp_server_id: 's1',
          server_name: 'odoo',
          granted_by: 'operator',
          granted_at: '2026-08-19T08:00:00.000Z',
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal('fetch', fetchMock);

    const grants = await getAgentGrants('hr-agent');

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('/bot-api/v1/operator/agents/hr-agent/grants');
    expect(init.method).toBeUndefined();
    expect(grants.grant_epoch).toBe('2026-08-25 17:00:00.000000+00');
    expect(grants.tool_grants[0]?.grant_epoch).toBe(
      '2026-08-25 17:00:00.000000+00',
    );
    expect(grants.tool_grants[1]?.grant_epoch).toBeNull();
    expect(grants.plugin_mcp_grants[0]?.plugin_id).toBe('@omadia/odoo');
  });

  it('URL-encodes the slug', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        slug: 'a b',
        grant_epoch: null,
        tool_grants: [],
        plugin_mcp_grants: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getAgentGrants('a b');

    expect(lastCall(fetchMock).url).toBe(
      '/bot-api/v1/operator/agents/a%20b/grants',
    );
  });
});

describe('getAgentPlugins / toggleAgentPlugin (#861)', () => {
  it('GETs the per-agent plugin assignment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        slug: 'hr-agent',
        fallback: false,
        plugins: [{ id: '@omadia/odoo', config: {}, enabled: true }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await getAgentPlugins('hr-agent');

    expect(lastCall(fetchMock).url).toBe(
      '/bot-api/v1/operator/agents/hr-agent/plugins',
    );
    expect(res.fallback).toBe(false);
    expect(res.plugins[0]?.enabled).toBe(true);
  });

  it('PATCHes a single-plugin toggle with the id in the BODY (ids contain "/")', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        fallback: false,
        plugin: { id: '@omadia/odoo', enabled: false },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await toggleAgentPlugin('hr-agent', '@omadia/odoo', false);

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('/bot-api/v1/operator/agents/hr-agent/plugins');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      id: '@omadia/odoo',
      enabled: false,
    });
    expect(res.plugin.enabled).toBe(false);
  });

  it('throws an ApiError whose body still carries the machine code', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'plugin_not_assigned' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    const err: unknown = await toggleAgentPlugin(
      'hr-agent',
      '@omadia/none',
      false,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(parseOperatorAgentErrorCode(err)).toBe('plugin_not_assigned');
  });
});

describe('parseOperatorAgentErrorCode (i18n hard rule support)', () => {
  it('extracts a known { error } code from the ApiError body', () => {
    const err = new ApiError(404, 'GET x failed: 404', '{"error":"not_found"}');
    expect(parseOperatorAgentErrorCode(err)).toBe('not_found');
  });

  it('is null for an unknown code, a non-JSON body, and a non-ApiError', () => {
    expect(
      parseOperatorAgentErrorCode(
        new ApiError(500, 'x', '{"error":"something_else"}'),
      ),
    ).toBeNull();
    expect(
      parseOperatorAgentErrorCode(new ApiError(502, 'x', '<html>502</html>')),
    ).toBeNull();
    expect(parseOperatorAgentErrorCode(new Error('plain'))).toBeNull();
    expect(parseOperatorAgentErrorCode(undefined)).toBeNull();
  });
});

describe('replaceMcpToolAllowlist (#862)', () => {
  const result: McpToolAllowlistResult = {
    agentSlug: 'hr-agent',
    mcpServerId: 's1',
    toolNames: ['read_employees', 'read_leaves'],
    granted: ['read_leaves'],
    revoked: ['delete_employee'],
    delegation: 'per_user',
    delegationScope: 'server',
  };

  it('PUTs toolNames[] and omits delegation when not given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result));
    vi.stubGlobal('fetch', fetchMock);

    const res = await replaceMcpToolAllowlist('hr-agent', 's1', [
      'read_employees',
      'read_leaves',
    ]);

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('/bot-api/v1/operator/mcp-grants');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      agentSlug: 'hr-agent',
      mcpServerId: 's1',
      toolNames: ['read_employees', 'read_leaves'],
    });
    expect(res.revoked).toEqual(['delete_employee']);
    expect(res.delegationScope).toBe('server');
  });

  it('sends delegation when given (per-SERVER switch, global effect)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result));
    vi.stubGlobal('fetch', fetchMock);

    await replaceMcpToolAllowlist('hr-agent', 's1', ['read_employees'], {
      delegation: 'per_user',
    });

    expect(JSON.parse(String(lastCall(fetchMock).init.body))).toEqual({
      agentSlug: 'hr-agent',
      mcpServerId: 's1',
      toolNames: ['read_employees'],
      delegation: 'per_user',
    });
  });

  it('an empty allowlist is a full revoke, not a malformed request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ...result, toolNames: [], granted: [], revoked: ['read_employees'] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await replaceMcpToolAllowlist('hr-agent', 's1', []);

    expect(JSON.parse(String(lastCall(fetchMock).init.body)).toolNames).toEqual([]);
    expect(res.toolNames).toEqual([]);
  });
});

describe('parseMcpGrantErrorCode (i18n hard rule support)', () => {
  it('extracts the verdict-gate rejection (409 config_validation)', () => {
    const err = new ApiError(
      409,
      'PUT /v1/operator/mcp-grants failed: 409',
      '{"error":"config_validation","message":"tool \\"x\\" is blocked"}',
    );
    expect(parseMcpGrantErrorCode(err)).toBe('config_validation');
  });

  it('covers the grant route codes and rejects unknown ones', () => {
    for (const code of [
      'invalid_grant',
      'invalid_delegation',
      'orchestrator_not_found',
      'mcp_server_not_found',
      'grant_not_found',
    ]) {
      expect(
        parseMcpGrantErrorCode(new ApiError(400, 'x', `{"error":"${code}"}`)),
      ).toBe(code);
    }
    expect(
      parseMcpGrantErrorCode(new ApiError(500, 'x', '{"error":"internal"}')),
    ).toBeNull();
    expect(parseMcpGrantErrorCode('not an error')).toBeNull();
  });
});

describe('shared type surface (extended, not re-declared)', () => {
  it('ToolGrantNode carries an OPTIONAL grantEpoch (absent on older middleware)', () => {
    const oldMiddleware: ToolGrantNode = {
      id: 'g1',
      agentId: 'a1',
      subAgentId: null,
      toolKind: 'mcp',
      toolRef: 'mcp:odoo:read_employees',
      mcpServerId: 's1',
    };
    const newMiddleware: ToolGrantNode = {
      ...oldMiddleware,
      grantEpoch: '2026-08-25 17:00:00.000000+00',
    };
    expect(oldMiddleware.grantEpoch).toBeUndefined();
    expect(newMiddleware.grantEpoch).toBe('2026-08-25 17:00:00.000000+00');
  });

  it('McpServerNode carries an OPTIONAL per-server delegation next to discoveredTools', () => {
    const server: McpServerNode = {
      id: 's1',
      name: 'odoo',
      transport: 'http',
      endpoint: 'https://mcp.example',
      status: 'enabled',
      lastDiscoveredAt: null,
      discoveredTools: [{ name: 'read_employees', description: 'list staff' }],
      delegation: 'service',
    };
    expect(server.discoveredTools[0]?.name).toBe('read_employees');
    expect(server.delegation).toBe('service');
  });

  it('McpGrantMatrixRow carries OPTIONAL delegation + grantEpoch decorations', () => {
    const row: McpGrantMatrixRow = {
      grantId: 'g1',
      holderKind: 'agent',
      agentSlug: 'hr-agent',
      agentName: 'HR',
      subAgentId: null,
      subAgentName: null,
      serverId: 's1',
      serverName: 'odoo',
      toolName: 'read_employees',
      severity: null,
      notYetScanned: false,
      acked: false,
      blocked: false,
      delegation: 'per_user',
      grantEpoch: null,
    };
    expect(row.delegation).toBe('per_user');
    expect(row.grantEpoch).toBeNull();
  });
});
