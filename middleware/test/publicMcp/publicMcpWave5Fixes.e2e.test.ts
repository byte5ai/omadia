import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import type { AuditEntry, AuditLog } from '@omadia/api-key-auth';
import { MCP_INVOKE_SCOPE, MCP_LIST_SCOPE, mcpWriteScope } from '@omadia/api-key-auth';

import type { PublicMcpAuditEntry } from '../../src/mcp/publicMcpServer.js';
import {
  callToolRequest,
  isSandboxListenDenied,
  listToolsRequest,
  maskingPrivacyService,
  MCP_ACCEPT,
  parseMcpJson,
  realDispatcher,
  startHarness,
  type Harness,
  type HarnessOptions,
} from './harness.js';

/**
 * Welle 5 / W11-12 — public MCP endpoint fixes, end to end through the real
 * middleware chain and the real `ToolDispatchService`:
 *
 *  - #1937 an upstream tool error is a tool error, not a privacy refusal;
 *  - #1938 a binding write tool gets the documented idempotency replay;
 *  - #1936 every authenticated request lands in the key's usage log;
 *  - #1952 `serverInfo.version` and the trailing slash.
 */

const READ_TOOL = 'query_crm';
const BINDING_WRITE_TOOL = 'mcp__tickets__createTicket';
const KEY_TOKEN = 'omadia_ak_test_token_wave5_aaaaaaaaaaaa';
const KEY_ID = 'key-wave5';

function recordingUsageLog(entries: AuditEntry[]): AuditLog {
  return {
    async record(entry) {
      entries.push(entry);
    },
    list: async () => [...entries],
    forKey: async (keyId) => entries.filter((e) => e.keyId === keyId),
    lastUsed: async () => ({}),
    forget: async () => {},
  };
}

function options(
  handlers: {
    readonly read?: () => Promise<{ content: string }>;
    readonly write?: () => Promise<{ content: string }>;
  },
  extra: Partial<HarnessOptions> = {},
): HarnessOptions {
  return {
    keys: [
      {
        token: KEY_TOKEN,
        id: KEY_ID,
        scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE, mcpWriteScope(BINDING_WRITE_TOOL)],
      },
    ],
    bindingRows: [
      {
        key_id: KEY_ID,
        agent_id: 'sales',
        read_tools: [READ_TOOL],
        // Declares no `writeCapabilities`: a write only because the binding says so.
        write_tools: [BINDING_WRITE_TOOL],
        write_rate_limit_per_minute: 10,
        enabled: true,
      },
    ],
    dispatchers: {
      sales: realDispatcher(
        [
          { name: READ_TOOL, handle: handlers.read ?? (async () => ({ content: 'ok' })) },
          {
            name: BINDING_WRITE_TOOL,
            handle: handlers.write ?? (async () => ({ content: 'written' })),
          },
        ],
        undefined,
        { idempotency: true },
      ),
    },
    allowWithoutPrivacyMasking: false,
    privacyService: maskingPrivacyService(),
    ...extra,
  };
}

describe('public MCP endpoint — Welle 5 fixes (W11-12)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function start(
    opts: HarnessOptions,
    t: { skip: (m: string) => void },
  ): Promise<Harness | undefined> {
    try {
      harness = await startHarness(opts);
      return harness;
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return undefined;
      }
      throw error;
    }
  }

  it('#1937 — a returned tool error is an isError result, audited as "tool reported an error"', async (t) => {
    const audit: PublicMcpAuditEntry[] = [];
    const h = await start(
      options({ read: async () => ({ content: 'Error: boom for jane@example.com' }) }, { audit }),
      t,
    );
    if (!h) return;
    const { payload } = await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    assert.equal(payload['error'], undefined, 'no JSON-RPC protocol error');
    const result = payload['result'] as { isError?: boolean; content?: { text: string }[] };
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(payload), /jane@example\.com|boom/);
    assert.equal(audit.at(-1)?.error, 'tool reported an error');
    assert.equal(audit.at(-1)?.ok, false);
  });

  it('#1938 — a binding write tool replays the first result for the same idempotency key', async (t) => {
    let runs = 0;
    const h = await start(
      options({
        write: async () => {
          runs += 1;
          return { content: `ticket-${String(runs)}` };
        },
      }),
      t,
    );
    if (!h) return;
    const request = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: BINDING_WRITE_TOOL, arguments: { title: 'Idem' }, _meta: { idempotencyKey: 'idem-1' } },
    };
    const first = await h.rpc(request, { token: KEY_TOKEN });
    const second = await h.rpc(request, { token: KEY_TOKEN });
    assert.equal(first.payload['error'], undefined);
    assert.equal(second.payload['error'], undefined);
    assert.equal(runs, 1, 'the tool ran once');
    assert.deepEqual(second.payload['result'], first.payload['result']);
  });

  it('#1936 — every authenticated request writes one usage-log entry with its outcome', async (t) => {
    const usage: AuditEntry[] = [];
    const h = await start(options({}, { wire: { keyAuditLog: recordingUsageLog(usage) } }), t);
    if (!h) return;
    await h.rpc(listToolsRequest(), { token: KEY_TOKEN });
    await h.rpc(callToolRequest(READ_TOOL), { token: KEY_TOKEN });
    await h.rpc(callToolRequest('not_bound_tool'), { token: KEY_TOKEN });
    // The entry is written when the response finishes; give the event loop a turn.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      usage.map((e) => [e.keyId, e.route, e.status]),
      [
        [KEY_ID, '/api/v1/mcp', 'ok'],
        [KEY_ID, '/api/v1/mcp', 'ok'],
        [KEY_ID, '/api/v1/mcp', 'forbidden'],
      ],
    );
  });

  it('#1952 — serverInfo.version is the app version, and a trailing slash reaches the endpoint', async (t) => {
    const h = await start(options({}, { wire: { appVersion: 'sha-test1234' } }), t);
    if (!h) return;
    const res = await fetch(`${h.url}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Authorization: `Bearer ${KEY_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    });
    assert.equal(res.status, 200);
    const payload = parseMcpJson(await res.text());
    const serverInfo = (payload['result'] as { serverInfo?: { version?: string } }).serverInfo;
    assert.equal(serverInfo?.version, 'sha-test1234');
  });
});
