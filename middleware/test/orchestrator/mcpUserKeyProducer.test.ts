/**
 * W4-1 — the missing `mcpUserKey` PRODUCER.
 *
 * Migration 0031 made MCP delegation explicit per server; `per_user` is the
 * default for every newly created one. The consumer side shipped in W0-1:
 * `resolveMcpUserKey` reads `turnContext.current()?.mcpUserKey` and fails
 * closed when nothing resolves. The PRODUCER never did — no chat path and no
 * channel path ever set the field — so every `per_user` server was dead from
 * chat and from Teams/Telegram, with the audit row recording `unresolved`.
 *
 * These tests drive the two producers through the REAL consumer functions
 * (`resolveMcpUserKey` / `auditIdentity` / `delegationBlockedMessage`), wired
 * exactly as `src/index.ts` wires them into `McpManager.auth`, so a green test
 * means the production decision — send a token, or refuse — comes out right.
 *
 * The probe reads the context where production reads it: on the streaming path,
 * only after the agent's generator has already yielded and been resumed by the
 * route's consumer loop.
 *
 * HONEST SCOPE NOTE. Swapping the streaming route's `turnContext.runGenerator`
 * for `turnContext.enter` does NOT turn these red — it was tried, and they
 * stayed green. `enterWith` at the top of an Express handler binds the store to
 * that handler's own async chain, and the `for await` consumer lives in that
 * same chain, so the value still arrives. `runGenerator` is still the correct
 * call there (it does not leak the scope into the consumer, and it drives the
 * generator's teardown inside the scope on a client abort) but the evidence for
 * THAT property is `turnContextPropagation.test.ts`'s consumer-leak assertion,
 * not these tests. What these tests do prove is the PRODUCER: delete the
 * `mcpUserKey` line and they go red with the delegation-blocked message.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type {
  LlmProvider,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import type {
  ChatAgent,
  ChatTurnInput,
  ChatTurnResult,
} from '@omadia/orchestrator';
import {
  NativeToolRegistry,
  Orchestrator,
  turnContext,
} from '@omadia/orchestrator';
import type { KnowledgeGraph } from '@omadia/plugin-api';

import { createChatRouter } from '../../src/routes/chat.js';
import {
  UNRESOLVED_IDENTITY,
  auditIdentity,
  delegationBlockedMessage,
  resolveMcpUserKey,
} from '../../src/services/mcpDelegation.js';

// ── the production decision, reproduced ─────────────────────────────────────

const PER_USER = { delegation: 'per_user' } as const;
const SERVICE = { delegation: 'service' } as const;
const SERVER_NAME = 'Kunden-CRM';

/**
 * What `McpManager.auth` does with the ambient turn context, condensed. Mirrors
 * `src/index.ts`: `getToken` refuses when `resolveMcpUserKey` returns null,
 * `resolveIdentity` writes `auditIdentity` to `mcp_call_log`, and
 * `onAuthFailure` explains with `delegationBlockedMessage`.
 */
interface McpDecision {
  /** The key a token would be looked up under, or null = send nothing. */
  readonly userKey: string | null;
  /** What lands in the `mcp_call_log` row. */
  readonly audited: string;
  /** The operator-facing refusal, or null when the call proceeds. */
  readonly blockedWith: string | null;
}

function decide(server: { delegation: 'per_user' | 'service' }): McpDecision {
  const candidate = turnContext.current()?.mcpUserKey;
  const userKey = resolveMcpUserKey(server, candidate);
  return {
    userKey,
    audited: auditIdentity(server, candidate),
    blockedWith: userKey === null ? delegationBlockedMessage(SERVER_NAME) : null,
  };
}

/** Both delegation modes, decided in the same turn scope. */
interface Probe {
  readonly perUser: McpDecision;
  readonly service: McpDecision;
}

const probe = (): Probe => ({ perUser: decide(PER_USER), service: decide(SERVICE) });

// ── part 1: the HTTP chat routes ────────────────────────────────────────────

/**
 * A ChatAgent that probes the ambient turn context the way a tool handler
 * would. The streaming half yields BEFORE probing — that suspension is the
 * whole point: it is where `enterWith` loses the store, and it is crossed on
 * every real turn long before the first tool runs.
 */
function probingChatAgent(sink: Probe[]): ChatAgent {
  return {
    chat: (_input: ChatTurnInput): Promise<ChatTurnResult> => {
      sink.push(probe());
      return Promise.resolve({ kind: 'message', text: 'ok' } as unknown as ChatTurnResult);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    chatStream: async function* () {
      yield { type: 'iteration_start', iteration: 1 };
      // …the consumer processes that event OUTSIDE the turn scope, and only
      // then resumes us. Anything read after this line proves the scope
      // survived a real generator suspension.
      await Promise.resolve();
      sink.push(probe());
      yield { type: 'done', text: 'ok' };
    },
  } as unknown as ChatAgent;
}

interface HttpHarness {
  readonly baseUrl: string;
  readonly probes: Probe[];
  close(): Promise<void>;
}

/** Mounts the real chat router behind a session-injecting middleware — the
 *  same shape `requireAuth` produces (`req.session = claims`). */
async function mountChat(): Promise<HttpHarness> {
  const probes: Probe[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.header('x-test-session-sub');
    if (sub !== undefined && sub !== '') {
      (req as express.Request).session = { sub } as NonNullable<express.Request['session']>;
    }
    next();
  });
  const agent = probingChatAgent(probes);
  app.use(
    '/api',
    createChatRouter({
      resolveChatAgent: () => agent,
      getDefaultSlug: () => 'probe-agent',
    }),
  );
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    probes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function postTurn(
  h: HttpHarness,
  path: '/chat' | '/chat/stream',
  sub?: string,
): Promise<void> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sub ? { 'x-test-session-sub': sub } : {}),
    },
    body: JSON.stringify({ message: 'los' }),
  });
  assert.equal(res.status, 200, `${path} did not serve the turn`);
  await res.text();
}

describe('W4-1 producer — HTTP chat routes', () => {
  it('MUTATION CHECK: non-streaming turn reaches a per_user server AS the session identity', async () => {
    const h = await mountChat();
    try {
      await postTurn(h, '/chat', 'alice@example.com');
      assert.equal(h.probes.length, 1, 'the chat agent never ran');
      const { perUser } = h.probes[0]!;
      assert.equal(
        perUser.userKey,
        'alice@example.com',
        'per_user delegation resolved no identity on an authenticated HTTP turn',
      );
      assert.equal(perUser.blockedWith, null, 'the turn was blocked despite a resolvable caller');
      assert.notEqual(perUser.audited, UNRESOLVED_IDENTITY);
    } finally {
      await h.close();
    }
  });

  it('MUTATION CHECK: STREAMING turn reaches a per_user server AS the session identity', async () => {
    // Read after the generator has yielded once and been resumed — the point in
    // the turn where any real tool (and so any MCP call) actually runs.
    const h = await mountChat();
    try {
      await postTurn(h, '/chat/stream', 'alice@example.com');
      assert.equal(h.probes.length, 1, 'the chat agent never ran');
      const { perUser } = h.probes[0]!;
      assert.equal(
        perUser.userKey,
        'alice@example.com',
        'per_user delegation resolved no identity on an authenticated streaming turn',
      );
      assert.equal(perUser.blockedWith, null, 'the turn was blocked despite a resolvable caller');
    } finally {
      await h.close();
    }
  });

  it('MUTATION CHECK: concurrent streaming turns never see each other`s identity', async () => {
    // The #445-class hazard: one shared store, or a scope bound to the wrong
    // async resource, shows up here as two turns agreeing on one identity.
    const h = await mountChat();
    try {
      await Promise.all([
        postTurn(h, '/chat/stream', 'alice@example.com'),
        postTurn(h, '/chat/stream', 'bob@example.com'),
      ]);
      assert.equal(h.probes.length, 2, 'both turns must have run');
      const keys = h.probes.map((p) => p.perUser.userKey).sort();
      assert.deepEqual(
        keys,
        ['alice@example.com', 'bob@example.com'],
        'two concurrent streaming turns did not each keep their own identity',
      );
    } finally {
      await h.close();
    }
  });

  it('W0-1 preserved: an UNAUTHENTICATED turn still fails closed on per_user', async () => {
    // The fix must not weaken the confused-deputy guard. No session ⇒ no
    // identity ⇒ no token, and the refusal names the server.
    const h = await mountChat();
    try {
      await postTurn(h, '/chat');
      await postTurn(h, '/chat/stream');
      assert.equal(h.probes.length, 2, 'both turns must have run');
      for (const p of h.probes) {
        assert.equal(p.perUser.userKey, null, 'an unauthenticated turn resolved an identity');
        assert.equal(p.perUser.audited, UNRESOLVED_IDENTITY);
        assert.equal(p.perUser.blockedWith, delegationBlockedMessage(SERVER_NAME));
      }
    } finally {
      await h.close();
    }
  });

  it('W0-1 preserved: the client-controlled x-user-id header is NOT an identity', async () => {
    // `resolveUserId` accepts this header, and it reaches the orchestrator as
    // `input.userId`. If either producer keyed MCP tokens on it, any caller
    // could act as any user. Belt and braces: assert it does not.
    const h = await mountChat();
    try {
      const res = await fetch(`${h.baseUrl}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'alice@example.com' },
        body: JSON.stringify({ message: 'los' }),
      });
      assert.equal(res.status, 200);
      await res.text();
      assert.equal(
        h.probes[0]?.perUser.userKey,
        null,
        'a client-supplied x-user-id header was accepted as the MCP identity',
      );
    } finally {
      await h.close();
    }
  });

  it('service delegation is unaffected, authenticated or not', async () => {
    const h = await mountChat();
    try {
      await postTurn(h, '/chat', 'alice@example.com');
      await postTurn(h, '/chat/stream', 'alice@example.com');
      await postTurn(h, '/chat');
      await postTurn(h, '/chat/stream');
      assert.equal(h.probes.length, 4);
      for (const p of h.probes) {
        assert.equal(p.service.userKey, 'operator', 'service delegation stopped resolving');
        assert.equal(p.service.audited, 'operator');
        assert.equal(p.service.blockedWith, null, 'a service server was blocked');
      }
    } finally {
      await h.close();
    }
  });
});

// ── part 2: the channel path (orchestrator, option (b)) ─────────────────────

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

function fakeProvider(streams: LlmStreamEvent[][]): LlmProvider {
  let idx = 0;
  const take = (): LlmStreamEvent[] => {
    if (idx >= streams.length) {
      throw new Error(`no scripted stream for provider call ${String(idx + 1)}`);
    }
    const events = streams[idx]!;
    idx += 1;
    return events;
  };
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      const events = take();
      return (events.at(-1) as { type: string; response: LlmResponse }).response;
    },
    stream: (): AsyncIterable<LlmStreamEvent> => {
      const events = take();
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

const PROBE_TOOL = 'probe_mcp_identity';

function toolCallStream(): LlmStreamEvent[] {
  return [
    {
      type: 'final',
      response: {
        content: [{ type: 'tool_call', id: 'tu-1', name: PROBE_TOOL, input: {} }],
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        model: 'test',
        usage: { inputTokens: 50, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    } as LlmStreamEvent,
  ];
}

function textStream(): LlmStreamEvent[] {
  return [
    { type: 'text_delta', text: 'fertig' },
    {
      type: 'final',
      response: {
        content: [{ type: 'text', text: 'fertig' }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'test',
        usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    } as LlmStreamEvent,
  ];
}

const CANONICAL_UUID = '3f5a6b1c-0000-4000-8000-00000000beef';
const CANONICAL_UUID_B = '3f5a6b1c-0000-4000-8000-0000000000b0';

/** Cluster roots by channel-native id, so two channel users are genuinely two
 *  different humans rather than one id the fake hands out twice. */
const CLUSTER_BY_CHANNEL_USER: Record<string, string> = {
  'aad-oid-1234': CANONICAL_UUID,
  'aad-oid-5678': CANONICAL_UUID_B,
};

/** The one KG method `resolveTurnOwnerIdentity` calls. */
function fakeKnowledgeGraph(): KnowledgeGraph {
  return {
    resolveOrCreateChannelIdentity: async (ingest: { channelUserId: string }) =>
      Promise.resolve({
        omadiaUserId: CLUSTER_BY_CHANNEL_USER[ingest.channelUserId] ?? CANONICAL_UUID,
      }),
  } as unknown as KnowledgeGraph;
}

interface ChannelHarness {
  readonly orchestrator: Orchestrator;
  readonly probes: Probe[];
}

function channelHarness(opts?: { readonly withGraph?: boolean }): ChannelHarness {
  const probes: Probe[] = [];
  const registry = new NativeToolRegistry();
  registry.register(PROBE_TOOL, {
    handler: async () => {
      probes.push(probe());
      return Promise.resolve('ok');
    },
    spec: {
      name: PROBE_TOOL,
      description: 'Decides the MCP identity from the ambient turn context.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    agentId: 'probe',
  });
  const orchestrator = new Orchestrator({
    provider: fakeProvider([toolCallStream(), textStream()]),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: registry,
    agentId: 'probe-agent',
    ...(opts?.withGraph === false ? {} : { knowledgeGraph: fakeKnowledgeGraph() }),
  });
  return { orchestrator, probes };
}

/** A Teams-shaped turn, exactly as `createOrchestratorDispatcher` builds it:
 *  raw channel-native `userId` PLUS the typed, server-attested
 *  `channelIdentity` derived from the adapter's authenticated `userRef`. */
const teamsTurn = {
  userMessage: 'los',
  sessionScope: 'teams-19:abc',
  userId: 'aad-oid-1234',
  channelIdentity: { channelKind: 'teams' as const, channelUserId: 'aad-oid-1234' },
};

async function drainStream(h: ChannelHarness, input: object): Promise<void> {
  for await (const _ of h.orchestrator.chatStream(input as never)) {
    // drain
  }
}

describe('W4-1 producer — channel turns (orchestrator, option (b))', () => {
  it('MUTATION CHECK: a Teams turn reaches a per_user server AS the canonical omadia user', async () => {
    // Channels go through `chatStream` via `createOrchestratorDispatcher`.
    const h = channelHarness();
    await drainStream(h, teamsTurn);
    assert.equal(h.probes.length, 1, 'the probe tool never ran');
    const { perUser } = h.probes[0]!;
    assert.equal(
      perUser.userKey,
      CANONICAL_UUID,
      'a channel turn resolved no MCP identity — per_user servers stay dead on Teams',
    );
    assert.equal(perUser.blockedWith, null, 'the channel turn was blocked despite a mapped user');
    assert.notEqual(perUser.audited, UNRESOLVED_IDENTITY);
  });

  it('MUTATION CHECK: the buffered path (runTurn) resolves it too', async () => {
    const h = channelHarness();
    await h.orchestrator.runTurn(teamsTurn as never);
    assert.equal(h.probes.length, 1, 'the probe tool never ran');
    assert.equal(h.probes[0]!.perUser.userKey, CANONICAL_UUID);
    assert.equal(h.probes[0]!.perUser.blockedWith, null);
  });

  it('W0-1 preserved: an UNRESOLVABLE channel identity still fails closed', async () => {
    // No KnowledgeGraph ⇒ `resolveTurnOwnerIdentity` returns undefined rather
    // than guessing with the raw channel-native id. No substitute is invented.
    const h = channelHarness({ withGraph: false });
    await drainStream(h, teamsTurn);
    assert.equal(h.probes.length, 1);
    assert.equal(
      h.probes[0]!.perUser.userKey,
      null,
      'an unresolvable channel user was given an identity anyway',
    );
    assert.equal(h.probes[0]!.perUser.audited, UNRESOLVED_IDENTITY);
    assert.equal(h.probes[0]!.perUser.blockedWith, delegationBlockedMessage(SERVER_NAME));
  });

  it('W0-1 preserved: a turn with NO channelIdentity never borrows input.userId', async () => {
    // This is the gate. Without `channelIdentity`, `resolveTurnOwnerIdentity`
    // returns `input.userId` verbatim — and on the HTTP path that id can come
    // straight from the client-supplied `x-user-id` header. Keying MCP tokens
    // on it would re-open the confused deputy one door along.
    const h = channelHarness();
    await drainStream(h, {
      userMessage: 'los',
      sessionScope: 'http-default',
      userId: 'alice@example.com',
    });
    assert.equal(h.probes.length, 1);
    assert.equal(
      h.probes[0]!.perUser.userKey,
      null,
      'input.userId was accepted as the MCP identity without a channelIdentity',
    );
  });

  it('an outer scope (an HTTP route) still WINS over the channel resolution', async () => {
    const h = channelHarness();
    await turnContext.run(
      { turnId: 'outer-http-turn', turnDate: '2026-07-31', mcpUserKey: 'alice@example.com' },
      () => drainStream(h, teamsTurn),
    );
    assert.equal(h.probes.length, 1);
    assert.equal(
      h.probes[0]!.perUser.userKey,
      'alice@example.com',
      'the orchestrator overrode an identity the route had already established',
    );
  });

  it('MUTATION CHECK: two INTERLEAVED channel turns from different users never cross identities', async () => {
    // The #445 class applied to this producer, and the case the HTTP
    // concurrency test does NOT reach: two channel turns advanced alternately
    // at the generator level, so a shared store — or a scope bound to the wrong
    // async resource — shows up as one identity serving both humans. That is
    // the failure mode where user B's turn would reach an MCP server holding
    // user A's token, which is strictly worse than failing closed.
    const a = channelHarness();
    const b = channelHarness();
    const genA = a.orchestrator.chatStream(teamsTurn as never);
    const genB = b.orchestrator.chatStream({
      ...teamsTurn,
      sessionScope: 'teams-19:def',
      userId: 'aad-oid-5678',
      channelIdentity: { channelKind: 'teams' as const, channelUserId: 'aad-oid-5678' },
    } as never);
    let doneA = false;
    let doneB = false;
    while (!doneA || !doneB) {
      if (!doneA) doneA = (await genA.next()).done === true;
      if (!doneB) doneB = (await genB.next()).done === true;
    }
    assert.equal(a.probes.length, 1, 'turn A never dispatched the probe');
    assert.equal(b.probes.length, 1, 'turn B never dispatched the probe');
    assert.equal(a.probes[0]!.perUser.userKey, CANONICAL_UUID);
    assert.equal(b.probes[0]!.perUser.userKey, CANONICAL_UUID_B);
    assert.notEqual(
      a.probes[0]!.perUser.userKey,
      b.probes[0]!.perUser.userKey,
      'two interleaved channel turns shared one MCP identity',
    );
  });

  it('service delegation is unaffected on channel turns', async () => {
    const h = channelHarness();
    await drainStream(h, teamsTurn);
    const hNoGraph = channelHarness({ withGraph: false });
    await drainStream(hNoGraph, teamsTurn);
    for (const p of [...h.probes, ...hNoGraph.probes]) {
      assert.equal(p.service.userKey, 'operator', 'service delegation stopped resolving');
      assert.equal(p.service.blockedWith, null, 'a service server was blocked');
    }
  });
});
