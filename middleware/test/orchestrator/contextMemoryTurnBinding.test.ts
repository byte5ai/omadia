/**
 * W5 memory-ACL (#860) — the `TurnOrigin` threading, exercised by a REAL turn.
 *
 * Issue #899 asks for the operator surface that makes `agents.context_memory`
 * switchable, and for someone to read the one part of the wave that shipped
 * with a stated residual risk: the binding is threaded through ~8 signatures
 * in `orchestrator.ts`, and the W5 suites all stop at `MemoryBinder`'s
 * HANDLER. Not one of them constructs an `Orchestrator` and runs a turn, so
 * every claim about the threading rested on reading the code.
 *
 * Reading it is not enough for this axis. The failure mode is silent by
 * construction: a binding lost at an await boundary, a call site that forgets
 * the parameter, a streaming generator resumed in the wrong async context —
 * none of them throw. They fall back to the agent-global tree, the turn
 * succeeds, and team A's notes are readable in team B. That is the shape of
 * bug that only a test which asserts the PHYSICAL PATH can catch.
 *
 * So these tests drive both entry points — `runTurn` (buffered) and
 * `chatStream` (streaming, the path every channel and the web-ui use, and the
 * one the residual-risk note singled out) — with a scripted provider that
 * calls the `memory` tool, and assert where the bytes actually landed in the
 * root store.
 *
 * Method note: each assertion below was verified to be load-bearing by
 * breaking the invariant (dropping `turnMemory` at the call site), rebuilding,
 * and confirming it turns red.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { InMemoryMemoryStore, MemoryToolHandler } from '@omadia/memory';
import {
  MemoryBinder,
  NativeToolRegistry,
  Orchestrator,
  type ContextMemoryMode,
} from '@omadia/orchestrator';
import type { TurnOrigin } from '../../packages/harness-channel-sdk/src/turnOrigin.js';

const AGENT_SLUG = 'w5-agent';
const AGENT_ROOT = `/memories/orchestrators/${AGENT_SLUG}`;

/**
 * A Teams turn in a channel of team `teamId` — the shape
 * `omadia-channel-teams` builds beside its `sessionScope`.
 * `memoryAxesForOrigin` resolves it to a channel tier with a team tier above.
 *
 * Built structurally, with no cast: a cast here would let a malformed origin
 * silently degrade to context-free and turn these tests into assertions about
 * the fallback rather than about the threading.
 */
function teamsOrigin(conversationId = 'c-1', teamId = 't-alpha'): TurnOrigin {
  return {
    channelType: 'teams',
    scope: { kind: 'conversation', channelId: 'msteams', conversationId },
    container: { kind: 'team', id: teamId },
  };
}

// ── scripted provider ───────────────────────────────────────────────────────

const providerCapabilities = {
  tools: true,
  vision: false,
  streaming: true,
  promptCaching: false,
  forcedToolChoice: false,
  parallelToolCalls: false,
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
      const final = events.at(-1) as { type: string; response: LlmResponse };
      return final.response;
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

function toolCallStream(input: unknown): LlmStreamEvent[] {
  return [
    {
      type: 'final',
      response: {
        content: [{ type: 'tool_call', id: 'tu-1', name: 'memory', input }],
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        model: 'test',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    } as LlmStreamEvent,
  ];
}

function textStream(text: string): LlmStreamEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'final',
      response: {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'test',
        usage: {
          inputTokens: 10,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    } as LlmStreamEvent,
  ];
}

/** One tool iteration that writes `path`, then a plain answer. */
function writeThenAnswer(path: string, fileText: string): LlmStreamEvent[][] {
  return [
    toolCallStream({ command: 'create', path, file_text: fileText }),
    textStream('fertig'),
  ];
}

/**
 * The undecorated root store, recording the PHYSICAL path of every write.
 *
 * Recording at the root is the whole method: every namespacer and scope guard
 * sits above it, so whatever arrives here is what actually hit storage. An
 * assertion on a decorated store would only re-state the decorator's own
 * arithmetic.
 */
class RecordingMemoryStore extends InMemoryMemoryStore {
  readonly writes: string[] = [];

  override async createFile(virtualPath: string, content: string): Promise<void> {
    this.writes.push(virtualPath);
    await super.createFile(virtualPath, content);
  }

  override async writeFile(virtualPath: string, content: string): Promise<void> {
    this.writes.push(virtualPath);
    await super.writeFile(virtualPath, content);
  }
}

interface Harness {
  readonly orchestrator: Orchestrator;
  /** The UNDECORATED root store — assertions read physical paths from here. */
  readonly root: RecordingMemoryStore;
}

function harness(mode: ContextMemoryMode, streams: LlmStreamEvent[][]): Harness {
  const root = new RecordingMemoryStore();
  const binder = new MemoryBinder({ agentSlug: AGENT_SLUG, root, mode });
  return {
    root,
    orchestrator: new Orchestrator({
      provider: fakeProvider(streams),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      agentId: AGENT_SLUG,
      // The build-time handler an unbound turn falls back to. Deliberately
      // present: if the binding were dropped anywhere the turn would still
      // succeed and write HERE, which is precisely what the assertions catch.
      memoryToolHandler: new MemoryToolHandler(root),
      memoryBinder: binder,
    }),
  };
}

async function drain(orchestrator: Orchestrator, origin?: TurnOrigin): Promise<void> {
  for await (const _ of orchestrator.chatStream({
    userMessage: 'los',
    sessionScope: 'sess-w5',
    ...(origin ? { origin } : {}),
  })) {
    // drain
  }
}

// ── 1. a turn WITH an origin lands in the context tier ───────────────────────

describe('W5 TurnOrigin threading — a real turn (#899)', () => {
  it('MUTATION CHECK: buffered runTurn with an origin writes into the CONTEXT tier', async () => {
    const h = harness('enforce', writeThenAnswer('/memories/note.md', 'alpha'));
    await h.orchestrator.runTurn({
      userMessage: 'los',
      sessionScope: 'sess-w5',
      origin: teamsOrigin(),
    });
    const paths = h.root.writes;
    assert.equal(paths.length, 1, `expected exactly one write, got ${paths.join(', ')}`);
    const written = paths[0]!;
    // The whole point of the wave: NOT the agent-global tree.
    assert.ok(
      !written.startsWith(`${AGENT_ROOT}/`),
      `write landed in the agent-global tree (${written}) — the binding was lost`,
    );
    assert.ok(
      written.startsWith(`/memories/contexts/${AGENT_SLUG}/`),
      `write did not land in a context tier: ${written}`,
    );
  });

  it('MUTATION CHECK: STREAMING chatStream with an origin writes into the CONTEXT tier', async () => {
    // THE test the residual-risk note asked for. `chatStream` binds in
    // `chatStreamInContext`, inside `turnContext.runGenerator`; an async
    // generator is resumed in the async context of whoever calls `.next()`,
    // which is exactly how an earlier wave silently lost `turnContext` on
    // every streaming turn. A binding lost the same way would not fail — it
    // would quietly write agent-global.
    const h = harness('enforce', writeThenAnswer('/memories/note.md', 'alpha'));
    await drain(h.orchestrator, teamsOrigin());
    const paths = h.root.writes;
    assert.equal(paths.length, 1, `expected exactly one write, got ${paths.join(', ')}`);
    const written = paths[0]!;
    assert.ok(
      !written.startsWith(`${AGENT_ROOT}/`),
      `streaming write landed in the agent-global tree (${written}) — the binding was lost`,
    );
    assert.ok(
      written.startsWith(`/memories/contexts/${AGENT_SLUG}/`),
      `streaming write did not land in a context tier: ${written}`,
    );
  });

  it('two different team contexts do not see each other', async () => {
    // The operator-facing promise in one assertion: what a turn in team alpha
    // writes is not listable from a turn in team beta.
    const alpha = harness('enforce', writeThenAnswer('/memories/note.md', 'alpha-secret'));
    await drain(alpha.orchestrator, teamsOrigin());
    const alphaPaths = alpha.root.writes;

    const beta = harness('enforce', writeThenAnswer('/memories/note.md', 'beta-secret'));
    await drain(beta.orchestrator, teamsOrigin('c-2', 't-beta'));
    const betaPaths = beta.root.writes;

    assert.equal(alphaPaths.length, 1);
    assert.equal(betaPaths.length, 1);
    assert.notEqual(
      alphaPaths[0],
      betaPaths[0],
      'two distinct team contexts resolved to the SAME physical path',
    );
  });
});

// ── 2. fail-closed: no origin, and mode off ─────────────────────────────────

describe('W5 fail-closed on a real turn (#899)', () => {
  it('MUTATION CHECK: a turn WITHOUT an origin stays agent-private under enforce', async () => {
    // An HTTP/API turn emits no `TurnOrigin` on purpose (`routes/chat.ts`).
    // Under `enforce` it must reduce to the agent-private tree — never to a
    // context tier it could name, and never to the raw store root.
    const h = harness('enforce', writeThenAnswer('/memories/note.md', 'api'));
    await drain(h.orchestrator);
    assert.deepEqual(h.root.writes, [`${AGENT_ROOT}/note.md`]);
  });

  it('MUTATION CHECK: streaming without an origin stays agent-private under enforce-strict', async () => {
    const h = harness('enforce-strict', writeThenAnswer('/memories/note.md', 'api'));
    await drain(h.orchestrator);
    assert.deepEqual(h.root.writes, [`${AGENT_ROOT}/note.md`]);
  });

  it('mode `off` ignores a present origin entirely (byte-identical rollout default)', async () => {
    // The rollout guarantee: until an operator flips the switch, an origin
    // arriving from a channel plugin changes nothing. This is what makes
    // #899's UI safe to ship ahead of any migration.
    const h = harness('off', writeThenAnswer('/memories/note.md', 'alpha'));
    await drain(h.orchestrator, teamsOrigin());
    assert.deepEqual(h.root.writes, [`${AGENT_ROOT}/note.md`]);
  });

  it('an unusable origin falls back to agent-private rather than throwing', async () => {
    // `channelType` outside the allowlist. Fail-closed means the turn still
    // completes — a dropped user turn would be the wrong trade — but narrower.
    const h = harness('enforce', writeThenAnswer('/memories/note.md', 'x'));
    await drain(h.orchestrator, {
      ...teamsOrigin(),
      channelType: 'carrier-pigeon',
    });
    assert.deepEqual(h.root.writes, [`${AGENT_ROOT}/note.md`]);
  });
});
