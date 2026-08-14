/**
 * Issue #562 phase 3 — MRTR against the DECLARED 2026-07-28 contract.
 *
 * `mcpPendingInput.test.ts` is the 2025-era half of this matrix: it drives a
 * hand-rolled legacy peer whose `input_required` result carries omadia's own
 * flat `inputRequests` array. This file is the other half — a real v2 server,
 * negotiated as `modern`, answering with the spec's shape:
 *
 *     { resultType: 'input_required',
 *       inputRequests: { '<key>': { method: 'elicitation/create', params: … } },
 *       requestState: '<opaque>' }
 *
 * Both eras must park, and both must replay. The risk #562 names is not that
 * one of them breaks loudly — it is era-dependent DIVERGENCE, where the same
 * tool behaves differently depending on which revision the peer speaks and
 * only one of the two is ever exercised. That is why this file exists at all.
 */

import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  InMemoryPendingMcpInputStore,
  MCP_INPUT_REQUIRED_SENTINEL_PREFIX,
  McpManager,
  claimMcpInputFromResults,
  planMcpInputReplay,
  type McpServerConfig,
  type PendingMcpInput,
} from '@omadia/orchestrator';

import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';

const TOOL = 'create_ticket';
const REQUEST_STATE = 'opaque-server-minted-state';
const OWNER = { userId: 'u1', sessionId: 's1' };

/**
 * Every `tools/call` body as it arrived ON THE WIRE.
 *
 * Read here rather than from `request.params` on purpose: v2's server decode
 * consumes the MRTR retry params (`inputResponses`, `requestState`) into its
 * own seam and never shows them to a raw `setRequestHandler` handler, so a
 * fixture asserting on `request.params` would report them missing when they
 * were sent perfectly. The wire is the contract.
 */
const wire: string[] = [];

/** How many `tools/call`s this peer has answered — the fixture's only way to
 *  tell the original from the retry, for the same reason. */
let callCount = 0;

/**
 * A real v2 server. `createMcpHandler` is the same serving entry phase 1
 * landed for the loopback server, so `server/discover` is answered and the
 * client's `'auto'` probe selects the modern era — which is the precondition
 * for everything below.
 */
function requestScopedServer(): McpServer {
  const mcp = new McpServer(
    { name: 'modern-mrtr-peer', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: TOOL,
        description: 'ask for the missing details',
        inputSchema: { type: 'object', properties: { subject: { type: 'string' } } },
      },
    ],
  }));
  mcp.server.setRequestHandler('tools/call', async () => {
    callCount += 1;
    if (callCount > 1) {
      return { content: [{ type: 'text' as const, text: 'Ticket angelegt' }] };
    }
    return {
      content: [{ type: 'text' as const, text: 'Ich brauche noch Angaben.' }],
      resultType: 'input_required',
      requestState: REQUEST_STATE,
      inputRequests: {
        details: {
          method: 'elicitation/create',
          params: {
            message: 'Bitte Kundennummer und PIN angeben.',
            requestedSchema: {
              type: 'object',
              properties: {
                customerNumber: { type: 'string', title: 'Kundennummer' },
                pin: { type: 'string', title: 'PIN', format: 'password' },
              },
              required: ['customerNumber'],
            },
          },
        },
      },
    };
  });
  return mcp;
}

async function startModernPeer(): Promise<{ url: string; close: () => Promise<void> }> {
  const node = toNodeHandler(createMcpHandler(() => requestScopedServer()));
  const http: HttpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (body.includes('"tools/call"')) wire.push(body);
    });
    void node(req, res);
  });
  await new Promise<void>((resolve) => {
    http.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
      }),
  };
}

const peer = await startModernPeer();
after(() => peer.close());

const CFG: McpServerConfig = {
  id: '00000000-0000-4000-8000-00000000f562',
  name: 'Kunden-CRM',
  transport: 'http',
  endpoint: peer.url,
};

function harness(): { store: InMemoryPendingMcpInputStore; manager: McpManager } {
  const store = new InMemoryPendingMcpInputStore();
  return { store, manager: new McpManager({ pendingInput: store }) };
}

async function inTurn<T>(turnId: string, fn: () => Promise<T>): Promise<T> {
  return turnContext.run(
    { turnId, turnDate: '2026-08-14', agentSlug: 'main', userId: 'u1', sessionScope: 's1' },
    fn,
  );
}

/** Park a call and claim the card the way the orchestrator does. */
async function park(
  h: { store: InMemoryPendingMcpInputStore; manager: McpManager },
  turnId: string,
): Promise<{ sentinel: string; record: PendingMcpInput }> {
  callCount = 0;
  const sentinel = await inTurn(turnId, () =>
    h.manager.callTool(CFG, TOOL, { subject: 'Drucker' }),
  );
  assert.ok(sentinel.startsWith(MCP_INPUT_REQUIRED_SENTINEL_PREFIX), sentinel);
  const record = claimMcpInputFromResults(h.store, [sentinel], OWNER);
  assert.ok(record, 'the parked card must be claimable');
  return { sentinel, record };
}

describe('#562 phase 3 — MRTR on a 2026-07-28 connection', () => {
  it('parks a spec-shaped input_required into a card', async () => {
    const h = harness();
    const { record } = await park(h, 't-modern-1');

    // The map dialect: one embedded elicitation, two properties, and every
    // field remembers which request asked for it.
    assert.deepEqual(
      record.inputRequests.map((f) => f.name),
      ['customerNumber', 'pin'],
    );
    assert.deepEqual(
      record.inputRequests.map((f) => f.requestKey),
      ['details', 'details'],
    );
    assert.equal(record.inputRequests[0]?.label, 'Kundennummer');
    // `format: 'password'` is the spec's way of saying "mask this".
    assert.equal(record.inputRequests[1]?.secret, true);
    // The spec is explicit about optionality; nothing is inferred.
    assert.equal(record.inputRequests[0]?.required, true);
    assert.equal(record.inputRequests[1]?.required, undefined);
    // The prose comes from the embedded request, not a top-level field.
    assert.equal(record.prompt, 'Bitte Kundennummer und PIN angeben.');
  });

  it('MUTATION CHECK: carries requestState verbatim onto the card', async () => {
    const h = harness();
    const { record } = await park(h, 't-modern-2');
    // Asserting the VALUE, not merely that the field is set: the spec has the
    // server treat this as attacker-controlled on re-entry and verify its own
    // integrity, so anything but a byte-exact echo silently breaks the
    // server's `requestState.verify` hook.
    assert.equal(record.requestState, REQUEST_STATE);
  });

  it('MUTATION CHECK: the replay sends spec inputResponses + a verbatim requestState', async () => {
    const h = harness();
    const { record } = await park(h, 't-modern-3');
    wire.length = 0;

    const plan = planMcpInputReplay(record, { customerNumber: '4711', pin: 'geheim' });
    const out = await inTurn('t-modern-3b', () =>
      h.manager.callTool(CFG, record.toolName, plan.args, plan.replay),
    );
    assert.equal(out, 'Ticket angelegt', out);

    assert.equal(wire.length, 1, 'the replay is exactly one tools/call');
    const sent = (JSON.parse(wire[0]!) as { params: Record<string, unknown> }).params;
    // One response per embedded request, keyed by the SERVER's key — this is
    // what `requestKey` on the field exists for.
    assert.deepEqual(sent['inputResponses'], {
      details: { action: 'accept', content: { customerNumber: '4711', pin: 'geheim' } },
    });
    // Byte-exact: the spec has the server verify this on re-entry, so anything
    // but a verbatim echo silently breaks its `requestState.verify` hook.
    assert.equal(sent['requestState'], REQUEST_STATE);
    // The tool's own arguments stay byte-exact across the park: the collected
    // answers ride the spec params, NOT `arguments`.
    assert.deepEqual(sent['arguments'], { subject: 'Drucker' });
    assert.equal(
      (sent['arguments'] as Record<string, unknown>)['inputResponses'],
      undefined,
      'the 2025-era argument form must not leak onto a modern connection',
    );
  });

  it('MUTATION CHECK: a replay that parks again trips the bounce cap', async () => {
    // The spec dialect carries nothing in `arguments` for the cap to
    // recognise, so `McpCallReplay.isReplay` is what keeps a server that asks
    // forever from bouncing forever. Without it this returns a second card.
    const h = harness();
    const { record } = await park(h, 't-modern-4');
    const plan = planMcpInputReplay(record, { customerNumber: '4711', pin: 'geheim' });
    // Make the peer ask a SECOND time on the retry — the case the cap exists
    // for, and the one a server with a broken form loop produces in the wild.
    callCount = 0;
    const out = await inTurn('t-modern-4b', () =>
      h.manager.callTool(CFG, record.toolName, plan.args, {
        isReplay: true,
        ...(record.requestState !== undefined ? { requestState: record.requestState } : {}),
      }),
    );
    assert.ok(out.startsWith('Error:'), out);
    assert.ok(!out.startsWith(MCP_INPUT_REQUIRED_SENTINEL_PREFIX), 'no second card may be issued');
  });

  it('MUTATION CHECK: the peer really negotiated the modern era', async () => {
    // Every assertion above would still pass against a 2025-era peer that
    // happened to send the same JSON — and the modern path, which is the only
    // one `allowInputRequired` and the elicitation capability affect, would
    // stop being covered while the file kept reporting green.
    const h = harness();
    const pooled = await (
      h.manager as unknown as {
        getOrConnect(
          cfg: McpServerConfig,
          token: string | null,
        ): Promise<{ client: { family: string; era: () => string } }>;
      }
    ).getOrConnect(CFG, null);
    assert.equal(pooled.client.family, 'v2');
    assert.equal(pooled.client.era(), 'modern');
  });
});
