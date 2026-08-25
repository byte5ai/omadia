import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAgentBuilderRouter } from '../src/routes/agentBuilder.js';
import { CURRENT_VERIFIER_VERSION } from '../src/services/skillVerdict.js';

/**
 * Route tests for the MCP grant surface (W0c, #862):
 * `PUT /mcp-grants` (single additive grant + allowlist replace + delegation
 * write) and `DELETE /mcp-grants/:grantId`.
 *
 * The W0c review found the changed routes shipping with zero route tests and
 * two behavioural defects this file pins:
 *
 *  - RAW vs NORMALIZED refs: `agent_tool_grants` is unique on the RAW
 *    tool_ref, so 'send_email' and 'odoo-mcp:send_email' are two rows that
 *    normalize to ONE tool name — a revoke must delete BOTH, or the agent
 *    silently keeps a tool the operator just revoked.
 *  - Gate scope: only tools that would be WRITTEN pass the verdict gate. An
 *    already-granted tool whose ack went stale ("granted but not callable")
 *    must not veto an unrelated clean edit — the dispatch guard blocks it at
 *    call time regardless.
 */

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const SERVER_ID = '22222222-2222-4222-8222-222222222222';
const GRANT_READ = '33333333-3333-4333-8333-333333333331';
const GRANT_MAIL_RAW = '33333333-3333-4333-8333-333333333332';
const GRANT_MAIL_PREFIXED = '33333333-3333-4333-8333-333333333333';

interface StubOptions {
  /** Current agent_tool_grants rows served by listAllToolGrants. */
  grants?: ReadonlyArray<Record<string, unknown>>;
  /** toolName → verdict severity; tools absent here have NO verdict. */
  verdicts?: Record<string, string>;
  /** toolNames whose needing-ack verdict has a matching ack. */
  acked?: readonly string[];
}

interface Harness {
  baseUrl: string;
  calls: {
    applyAllowlist: Array<Record<string, unknown>>;
    setDelegation: Array<[string, string]>;
    bumpEpoch: string[];
    deleteGrant: string[];
  };
  close(): Promise<void>;
}

function grantRow(id: string, toolRef: string): Record<string, unknown> {
  return {
    id,
    agentId: AGENT_ID,
    subAgentId: null,
    toolKind: 'mcp',
    toolRef,
    mcpServerId: SERVER_ID,
    config: {},
    createdAt: new Date(0),
    grantEpoch: null,
  };
}

async function makeHarness(opts: StubOptions = {}): Promise<Harness> {
  const calls: Harness['calls'] = {
    applyAllowlist: [],
    setDelegation: [],
    bumpEpoch: [],
    deleteGrant: [],
  };
  const verdicts = opts.verdicts ?? {};
  const acked = new Set(opts.acked ?? []);
  const server = {
    id: SERVER_ID,
    name: 'odoo-mcp',
    transport: 'http',
    endpoint: 'https://odoo.example/mcp',
    status: 'enabled',
    lastDiscoveredAt: null,
    discoveredTools: [],
    delegation: 'service',
    source: 'manual',
    registryId: null,
    license: null,
    author: null,
    sourceUrl: null,
    privacyBypass: false,
    kgIngest: false,
    configSchema: [],
    config: {},
    headers: {},
  };
  const graph = {
    listMcpServers: () => Promise.resolve([server]),
    listAllToolGrants: () => Promise.resolve(opts.grants ?? []),
    getMcpToolVerdict: (_sid: string, toolName: string, version: number) => {
      assert.equal(version, CURRENT_VERIFIER_VERSION);
      const severity = verdicts[toolName];
      return Promise.resolve(
        severity === undefined
          ? undefined
          : { serverId: SERVER_ID, toolName, severity, contentHash: `hash:${toolName}` },
      );
    },
    getMcpToolVerdictAck: (_sid: string, toolName: string) =>
      Promise.resolve(
        acked.has(toolName)
          ? { serverId: SERVER_ID, toolName, contentHash: `hash:${toolName}` }
          : undefined,
      ),
    // refreshMcpGrantPolicy reads these in bulk.
    listMcpToolVerdicts: () => Promise.resolve([]),
    listMcpToolVerdictAcks: () => Promise.resolve([]),
    applyMcpToolAllowlist: (input: Record<string, unknown>) => {
      calls.applyAllowlist.push(input);
      return Promise.resolve();
    },
    setMcpServerDelegation: (serverId: string, delegation: string) => {
      calls.setDelegation.push([serverId, delegation]);
      return Promise.resolve({ ...server, delegation });
    },
    bumpMcpGrantEpoch: (serverId: string) => {
      calls.bumpEpoch.push(serverId);
      return Promise.resolve();
    },
    deleteToolGrant: (id: string) => {
      calls.deleteGrant.push(id);
      return Promise.resolve();
    },
  };
  const config = {
    listAgents: () => Promise.resolve([{ id: AGENT_ID, slug: 'sales' }]),
    getAgentBySlug: () => Promise.resolve(undefined),
  };

  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/operator',
    createAgentBuilderRouter({
      getConfigStore: () => config as never,
      getGraphStore: () => graph as never,
      getRegistry: () => undefined,
    }),
  );
  const httpServer: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (httpServer.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    calls,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function putGrants(h: Harness, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${h.baseUrl}/api/v1/operator/mcp-grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /mcp-grants (allowlist replace, W0c #862)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
  });

  it('replaces the allowlist in one transactional store call: grants the new, revokes the dropped', async () => {
    h = await makeHarness({
      grants: [grantRow(GRANT_READ, 'read_ticket'), grantRow(GRANT_MAIL_RAW, 'send_email')],
      verdicts: { read_ticket: 'no_signals', list_tickets: 'no_signals', send_email: 'no_signals' },
    });
    const res = await putGrants(h, {
      agentSlug: 'sales',
      mcpServerId: SERVER_ID,
      toolNames: ['read_ticket', 'list_tickets'],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body['granted'], ['list_tickets']);
    assert.deepEqual(body['revoked'], ['send_email']);
    assert.deepEqual(body['toolNames'], ['list_tickets', 'read_ticket']);
    assert.equal(h.calls.applyAllowlist.length, 1);
    assert.deepEqual(h.calls.applyAllowlist[0], {
      agentId: AGENT_ID,
      mcpServerId: SERVER_ID,
      grantRefs: ['list_tickets'],
      revokeIds: [GRANT_MAIL_RAW],
    });
    assert.deepEqual(h.calls.bumpEpoch, [SERVER_ID]);
  });

  it('revokes EVERY row behind a normalized name — raw and serverName-prefixed refs alike', async () => {
    // agent_tool_grants is unique on the RAW tool_ref (0014): 'send_email'
    // and 'odoo-mcp:send_email' are two rows for ONE tool. Revoking the tool
    // must delete both, or the agent keeps a tool the response reports as
    // revoked (the W0c blocker).
    h = await makeHarness({
      grants: [
        grantRow(GRANT_READ, 'read_ticket'),
        grantRow(GRANT_MAIL_RAW, 'send_email'),
        grantRow(GRANT_MAIL_PREFIXED, 'odoo-mcp:send_email'),
      ],
      verdicts: { read_ticket: 'no_signals', send_email: 'no_signals' },
    });
    const res = await putGrants(h, {
      agentSlug: 'sales',
      mcpServerId: SERVER_ID,
      toolNames: ['read_ticket'],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body['revoked'], ['send_email']);
    assert.equal(h.calls.applyAllowlist.length, 1);
    assert.deepEqual(
      [...(h.calls.applyAllowlist[0]!['revokeIds'] as string[])].sort(),
      [GRANT_MAIL_RAW, GRANT_MAIL_PREFIXED].sort(),
      'both rows normalizing to send_email must be deleted',
    );
  });

  it('gates only tools that would be written — a stale-acked EXISTING grant cannot veto a clean edit', async () => {
    // send_email is granted and its high_risk verdict lost its ack (the
    // "granted but not callable" state the matrix exists to display). Adding
    // the clean list_tickets must succeed; the dispatch guard handles
    // send_email at call time.
    h = await makeHarness({
      grants: [grantRow(GRANT_READ, 'read_ticket'), grantRow(GRANT_MAIL_RAW, 'send_email')],
      verdicts: {
        read_ticket: 'no_signals',
        list_tickets: 'no_signals',
        send_email: 'high_risk', // no ack → currently blocked
      },
    });
    const res = await putGrants(h, {
      agentSlug: 'sales',
      mcpServerId: SERVER_ID,
      toolNames: ['read_ticket', 'send_email', 'list_tickets'],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body['granted'], ['list_tickets']);
    assert.deepEqual(body['revoked'], []);
  });

  it('a gate rejection aborts the WHOLE edit before any write', async () => {
    h = await makeHarness({
      grants: [grantRow(GRANT_READ, 'read_ticket')],
      verdicts: { read_ticket: 'no_signals' }, // evil_tool: never scanned
    });
    const res = await putGrants(h, {
      agentSlug: 'sales',
      mcpServerId: SERVER_ID,
      toolNames: ['read_ticket', 'evil_tool'],
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['error'], 'config_validation');
    assert.equal(h.calls.applyAllowlist.length, 0, 'no store write after a gate rejection');
    assert.deepEqual(h.calls.bumpEpoch, []);
  });

  it('single-grant mode stays additive and backwards compatible', async () => {
    h = await makeHarness({
      grants: [],
      verdicts: { read_ticket: 'no_signals' },
    });
    const res = await putGrants(h, {
      agentSlug: 'sales',
      mcpServerId: SERVER_ID,
      toolName: 'read_ticket',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['toolName'], 'read_ticket');
    assert.equal(body['granted'], true);
    assert.equal(h.calls.applyAllowlist.length, 1);
    assert.deepEqual(h.calls.applyAllowlist[0]!['grantRefs'], ['read_ticket']);
    assert.deepEqual(h.calls.applyAllowlist[0]!['revokeIds'], [], 'single mode never revokes');
  });

  it('writes the server delegation mode when requested and reports the server scope', async () => {
    h = await makeHarness({ grants: [], verdicts: { read_ticket: 'no_signals' } });
    const res = await putGrants(h, {
      agentSlug: 'sales',
      mcpServerId: SERVER_ID,
      toolNames: ['read_ticket'],
      delegation: 'per_user',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['delegation'], 'per_user');
    assert.equal(body['delegationScope'], 'server');
    assert.deepEqual(h.calls.setDelegation, [[SERVER_ID, 'per_user']]);
  });

  it('rejects an invalid delegation value with 400 invalid_delegation', async () => {
    h = await makeHarness();
    const res = await putGrants(h, {
      agentSlug: 'sales',
      mcpServerId: SERVER_ID,
      toolNames: ['read_ticket'],
      delegation: 'both_please',
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as Record<string, unknown>)['error'], 'invalid_delegation');
  });

  it('rejects an unknown mcpServerId with 404 mcp_server_not_found', async () => {
    h = await makeHarness();
    const res = await putGrants(h, {
      agentSlug: 'sales',
      mcpServerId: '99999999-9999-4999-8999-999999999999',
      toolNames: ['read_ticket'],
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as Record<string, unknown>)['error'], 'mcp_server_not_found');
  });
});

describe('DELETE /mcp-grants/:grantId (W0c #862)', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
  });

  it('deletes an MCP grant, refreshes the policy and bumps the epoch', async () => {
    h = await makeHarness({ grants: [grantRow(GRANT_READ, 'read_ticket')] });
    const res = await fetch(`${h.baseUrl}/api/v1/operator/mcp-grants/${GRANT_READ}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 204);
    assert.deepEqual(h.calls.deleteGrant, [GRANT_READ]);
    assert.deepEqual(h.calls.bumpEpoch, [SERVER_ID]);
  });

  it('refuses to delete a native grant through the MCP endpoint', async () => {
    h = await makeHarness({
      grants: [{ ...grantRow(GRANT_READ, 'memory.search'), toolKind: 'native', mcpServerId: null }],
    });
    const res = await fetch(`${h.baseUrl}/api/v1/operator/mcp-grants/${GRANT_READ}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as Record<string, unknown>)['error'], 'not_an_mcp_grant');
    assert.deepEqual(h.calls.deleteGrant, []);
  });

  it('404s for a grant id that does not exist', async () => {
    h = await makeHarness({ grants: [] });
    const res = await fetch(`${h.baseUrl}/api/v1/operator/mcp-grants/${GRANT_READ}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as Record<string, unknown>)['error'], 'grant_not_found');
  });
});
