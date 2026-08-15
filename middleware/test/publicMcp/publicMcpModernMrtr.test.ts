/**
 * Issue #700 — MRTR on the public MCP endpoint, 2026-07-28 era.
 *
 * `publicMcpInputRequired.test.ts` is the 2025-era half: it drives the same
 * endpoint with plain JSON-RPC and asserts omadia's flat `inputRequests` array
 * dialect, unchanged. This file is the other half, and it drives a REAL
 * `@modelcontextprotocol/client@2` against the SAME mounted route.
 *
 * Why both must exist, stated once: the endpoint now serves two SDK
 * generations, chosen by the protocol era of the request. Neither can serve the
 * other's era — the v1 line never answers `server/discover` (so a modern client
 * negotiating against it falls back to legacy, where it strips `resultType` and
 * MRTR becomes invisible), and the v2 line refuses to emit omadia's array
 * dialect at all. A suite covering one era would report green while the other
 * was entirely broken.
 *
 * What is asserted here beyond "it works":
 *
 *  - The era really is `modern`, so this file cannot silently drift onto the
 *    legacy path and keep passing.
 *  - `requestState` is integrity-protected. A tampered one is REFUSED, which
 *    is the spec's server requirement and the one property that is invisible
 *    in a happy-path test.
 *  - The tool sees the identical flat `inputResponses` object it sees on the
 *    2025-era dialect. Era-dependent divergence in what a TOOL observes is the
 *    failure mode this whole split exists to avoid.
 */

import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  Client,
  StreamableHTTPClientTransport,
  isInputRequiredResult,
} from '@modelcontextprotocol/client';
import { MCP_INVOKE_SCOPE, MCP_LIST_SCOPE } from '@omadia/api-key-auth';
import type { ToolDispatchResult } from '@omadia/orchestrator';

import { PENDING_INPUT_REQUEST_KEY } from '../../src/mcp/publicMcpInputRequired.js';
import { MODERN_INPUT_REQUEST_KEY } from '../../src/mcp/publicMcpModernMrtr.js';
import {
  fakeDispatcher,
  isSandboxListenDenied,
  startHarness,
  type Harness,
  type HarnessOptions,
} from './harness.js';

const TOOL = 'book_room';
const KEY_TOKEN = 'omadia_ak_test_token_cccccccccccccccc';
const KEY_ID = 'key-modern-mrtr';

/** Every argument object the dispatcher was handed, in order. */
const seen: unknown[] = [];

/** A tool that asks for a PIN once, then completes using what came back. */
async function bookRoom(input: unknown): Promise<ToolDispatchResult> {
  seen.push(input);
  const args = (input ?? {}) as Record<string, unknown>;
  const responses = args['inputResponses'] as Record<string, unknown> | undefined;
  if (responses && Object.keys(responses).length > 0) {
    return { content: `booked ${String(args['roomId'])} with pin=${String(responses['pin'])}` };
  }
  return {
    content: JSON.stringify({
      [PENDING_INPUT_REQUEST_KEY]: {
        message: 'PIN required for this room.',
        inputRequests: [{ name: 'pin', label: 'PIN', secret: true, required: true }],
      },
    }),
  };
}

/** A tool that asks every time — the bounce the round cap has to refuse. */
async function alwaysAsks(input: unknown): Promise<ToolDispatchResult> {
  seen.push(input);
  return {
    content: JSON.stringify({
      [PENDING_INPUT_REQUEST_KEY]: { message: 'again', inputRequests: [{ name: 'pin' }] },
    }),
  };
}

function options(handle: (input: unknown) => Promise<ToolDispatchResult>): HarnessOptions {
  return {
    keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] }],
    bindingRows: [
      {
        key_id: KEY_ID,
        agent_id: 'ops',
        read_tools: [TOOL],
        write_tools: [],
        write_rate_limit_per_minute: 5,
        enabled: true,
      },
    ],
    dispatchers: { ops: fakeDispatcher([{ name: TOOL, handle }]) },
  };
}

const started: Harness[] = [];
const clients: Client[] = [];
after(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const h of started.splice(0)) await h.close();
});

async function start(
  opts: HarnessOptions,
  t: { skip: (m: string) => void },
): Promise<Harness | undefined> {
  try {
    const h = await startHarness(opts);
    started.push(h);
    return h;
  } catch (error) {
    if (isSandboxListenDenied(error)) {
      t.skip('sandbox blocks loopback listeners on 127.0.0.1');
      return undefined;
    }
    throw error;
  }
}

/**
 * Build `tools/call` params for a retry leg.
 *
 * The cast is the point, not an accident: `@modelcontextprotocol/client@2` does
 * not MODEL `inputResponses` / `requestState` on `callTool`'s params even
 * though its transport serialises them onto the wire exactly as the spec
 * requires (verified against the raw POST bodies). A real integration hits the
 * same gap, so the test reproduces what that integration has to write rather
 * than routing around it.
 */
function retryParams(params: Record<string, unknown>): Parameters<Client['callTool']>[0] {
  return params as unknown as Parameters<Client['callTool']>[0];
}

/** The `requestState` off an ask, read through `unknown` because the SDK's
 *  result type does not carry it either. */
function stateOf(result: unknown): string {
  const state = (result as { requestState?: unknown }).requestState;
  assert.equal(typeof state, 'string', 'an ask must carry a requestState');
  return state as string;
}

/** A negotiating client, authenticated exactly as a real integration would be. */
async function connect(harness: Harness): Promise<Client> {
  const client = new Client(
    { name: 'modern-integration', version: '0.0.0' },
    {
      versionNegotiation: { mode: 'auto' },
      // omadia parks and asks a human; it never fulfils in-process.
      inputRequired: { autoFulfill: false },
      capabilities: { elicitation: {} },
    },
  );
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(harness.url), {
      requestInit: { headers: { Authorization: `Bearer ${KEY_TOKEN}` } },
    }),
  );
  return client;
}

describe('#700 — the public endpoint serves MRTR to a 2026-07-28 client', () => {
  it('MUTATION CHECK: negotiates the modern era against this endpoint', async (t) => {
    // Load-bearing: every assertion below would also pass on a legacy
    // connection that happened to answer similarly, and the modern leg —
    // the only one `requestState` and the embedded elicitation exist on —
    // would stop being covered while this file kept reporting green.
    const h = await start(options(bookRoom), t);
    if (!h) return;
    const client = await connect(h);
    assert.equal(client.getProtocolEra(), 'modern');
  });

  it('MUTATION CHECK: emits the CacheableResult hints on the era that can read them (#545)', async (t) => {
    // `publicMcpEndpoint.e2e.test.ts` pins the same two fields on the 2025
    // leg. This is the half that matters: `ttlMs` / `cacheScope` are
    // 2026-07-28 vocabulary, and #700 split this handler in two, so hints
    // added to the legacy leg alone would advertise a cache policy to exactly
    // the callers who cannot see it.
    const h = await start(options(bookRoom), t);
    if (!h) return;
    const client = await connect(h);

    const listed = (await client.listTools(undefined, { cacheMode: 'bypass' })) as unknown as {
      ttlMs?: unknown;
      cacheScope?: unknown;
    };
    assert.equal(listed.ttlMs, 60_000);
    // `private` is mandatory, not chosen: the list is filtered per API key, so
    // a shared entry would leak which tools OTHER keys may call.
    assert.equal(listed.cacheScope, 'private');
  });

  it('asks with a spec-shaped embedded elicitation and an opaque requestState', async (t) => {
    const h = await start(options(bookRoom), t);
    if (!h) return;
    const client = await connect(h);

    const result = await client.callTool(
      { name: TOOL, arguments: { roomId: 'r1' } },
      { allowInputRequired: true },
    );

    assert.ok(isInputRequiredResult(result), JSON.stringify(result));
    const requests = (result as { inputRequests?: Record<string, unknown> }).inputRequests ?? {};
    assert.deepEqual(Object.keys(requests), [MODERN_INPUT_REQUEST_KEY]);
    const embedded = requests[MODERN_INPUT_REQUEST_KEY] as {
      method: string;
      params: { message: string; requestedSchema: Record<string, unknown> };
    };
    assert.equal(embedded.method, 'elicitation/create');
    assert.match(embedded.params.message, /PIN required for this room\./);
    // The spec has no masked-input concept, so the secrecy the tool declared is
    // carried in prose rather than dropped.
    assert.match(embedded.params.message, /Sensitive/);
    assert.deepEqual(
      Object.keys(
        (embedded.params.requestedSchema as { properties: Record<string, unknown> }).properties,
      ),
      ['pin'],
    );
    assert.deepEqual(
      (embedded.params.requestedSchema as { required: string[] }).required,
      ['pin'],
    );
    assert.equal(
      typeof (result as { requestState?: unknown }).requestState,
      'string',
      'a modern ask must carry a requestState',
    );
  });

  it('completes the retry, and the TOOL sees the same flat object as on 2025-era', async (t) => {
    const h = await start(options(bookRoom), t);
    if (!h) return;
    const client = await connect(h);
    seen.length = 0;

    const ask = await client.callTool(
      { name: TOOL, arguments: { roomId: 'r1' } },
      { allowInputRequired: true },
    );
    const done = await client.callTool(
      retryParams({
        name: TOOL,
        arguments: { roomId: 'r1' },
        inputResponses: {
          [MODERN_INPUT_REQUEST_KEY]: { action: 'accept', content: { pin: '4711' } },
        },
        requestState: stateOf(ask),
      }),
      { allowInputRequired: true },
    );

    assert.equal(
      (done as { content?: { text?: string }[] }).content?.[0]?.text,
      'booked r1 with pin=4711',
    );
    // The whole point of translating in the endpoint rather than the dispatch
    // layer: a tool cannot tell which era its caller spoke.
    assert.deepEqual(seen[1], { roomId: 'r1', inputResponses: { pin: '4711' } });
  });

  it('MUTATION CHECK: refuses a tampered requestState', async (t) => {
    // The spec's server requirement, and the one property a happy-path test
    // cannot see: `requestState` round-trips through the client and is
    // attacker-controlled on re-entry.
    const h = await start(options(bookRoom), t);
    if (!h) return;
    const client = await connect(h);

    const ask = await client.callTool(
      { name: TOOL, arguments: { roomId: 'r1' } },
      { allowInputRequired: true },
    );
    const state = stateOf(ask);
    // Mutated in the MIDDLE: appending to a base64url tail can be absorbed by a
    // lenient decoder and would prove nothing.
    const tampered = `${state.slice(0, 8)}${state[8] === 'A' ? 'B' : 'A'}${state.slice(9)}`;

    await assert.rejects(
      client.callTool(
        retryParams({
          name: TOOL,
          arguments: { roomId: 'r1' },
          inputResponses: {
            [MODERN_INPUT_REQUEST_KEY]: { action: 'accept', content: { pin: '4711' } },
          },
          requestState: tampered,
        }),
        { allowInputRequired: true },
      ),
      /Invalid or expired requestState/,
    );
  });

  it('MUTATION CHECK: the round cap is read off the signed state, not the arguments', async (t) => {
    // On the 2025-era dialect the cap is inferred from `inputResponses` being
    // present in the arguments, so a caller that strips the key gets a fresh
    // card forever. Here the count is under the endpoint's own MAC, so the
    // same trick cannot work: the retry below carries NO answers at all and is
    // still recognised as the second round.
    const h = await start(options(alwaysAsks), t);
    if (!h) return;
    const client = await connect(h);

    const ask = await client.callTool(
      { name: TOOL, arguments: { roomId: 'r1' } },
      { allowInputRequired: true },
    );
    const second = await client.callTool(
      retryParams({ name: TOOL, arguments: { roomId: 'r1' }, requestState: stateOf(ask) }),
      { allowInputRequired: true },
    );

    assert.equal((second as { isError?: boolean }).isError, true, JSON.stringify(second));
    assert.match(
      (second as { content?: { text?: string }[] }).content?.[0]?.text ?? '',
      /asked for user input again/,
    );
  });
});
