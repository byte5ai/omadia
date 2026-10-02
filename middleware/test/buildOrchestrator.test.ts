/**
 * US3 — verifies per-Agent Orchestrator construction: `buildOrchestratorForAgent`
 * is callable more than once in one process and yields fully independent
 * instances, each carrying its own `agentId`, with no shared mutable state.
 */

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAnthropicClient,
  createAnthropicProvider,
} from '@omadia/llm-adapter-anthropic';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
} from '@omadia/plugin-api';

import {
  buildOrchestratorForAgent,
  type OrchestratorDeps,
} from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { RunTraceOutcomeStats } from '../packages/harness-orchestrator/src/runTraceObservability.js';

/** Minimal NativeToolRegistry — the Orchestrator constructor only calls
 *  `has` and `register` while seeding the kernel native-tool names. */
function fakeNativeToolRegistry(): NativeToolRegistry {
  const names = new Set<string>();
  return {
    has: (name: string) => names.has(name),
    register: (name: string) => {
      names.add(name);
      return () => names.delete(name);
    },
  } as unknown as NativeToolRegistry;
}

function deps(): OrchestratorDeps {
  return {
    provider: createAnthropicProvider({
      client: createAnthropicClient({ apiKey: 'test-key' }),
    }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
  };
}

test('builds two independent orchestrators for two Agents', () => {
  const a = buildOrchestratorForAgent(
    { agentId: 'public', model: 'm', maxTokens: 100, maxToolIterations: 4 },
    deps(),
  );
  const b = buildOrchestratorForAgent(
    { agentId: 'general', model: 'm', maxTokens: 100, maxToolIterations: 4 },
    deps(),
  );

  assert.notEqual(a.orchestrator, b.orchestrator);
  assert.equal(a.orchestrator.agentId, 'public');
  assert.equal(b.orchestrator.agentId, 'general');
  assert.notEqual(a.bundle.chatSessionStore, b.bundle.chatSessionStore);
  assert.notEqual(a.bundle.sessionLogger, b.bundle.sessionLogger);
});

test('the built bundle exposes the orchestrator as its raw + bare agent', () => {
  const built = buildOrchestratorForAgent(
    { agentId: 'solo', model: 'm', maxTokens: 100, maxToolIterations: 4 },
    deps(),
  );
  assert.equal(built.bundle.raw, built.orchestrator);
  // No verifier bundle in deps → the bare Orchestrator IS the chatAgent.
  assert.equal(built.bundle.agent, built.orchestrator);
});

/**
 * #1016 — the WIRING pin.
 *
 * The guard itself is tested in `routineTurnOwnerGuard.test.ts`. What this
 * pins is that the production construction path actually installs it: the
 * first round of this fix shipped a correct guard with no caller, so a stale
 * `enterWith` chain still dispatched under the previous principal. Deleting
 * the `turnOwnerGuard` forward in `buildOrchestrator.ts` must fail here.
 */
function cliDeps(
  turnOwnerGuard?: OrchestratorDeps['turnOwnerGuard'],
): OrchestratorDeps {
  return {
    ...deps(),
    // Only `id` is read at construction time; the CLI runtime owns the turn
    // loop, so nothing calls stream()/complete() on this provider.
    provider: { id: 'claude-cli' } as unknown as OrchestratorDeps['provider'],
    ...(turnOwnerGuard ? { turnOwnerGuard } : {}),
  };
}

/** Reads the private deps the agent was constructed with. */
function installedGuard(agent: unknown): unknown {
  return (agent as { deps?: { turnOwnerGuard?: unknown } }).deps?.turnOwnerGuard;
}

test('a claude-cli agent is built with the turn-owner guard from deps (#1016)', () => {
  const guard: OrchestratorDeps['turnOwnerGuard'] = () => (): void => {};
  const built = buildOrchestratorForAgent(
    { agentId: 'cli', model: 'opus-cli', maxTokens: 100, maxToolIterations: 4 },
    cliDeps(guard),
  );

  // The CLI branch swaps the agent for the CLI runtime rather than the
  // orchestrator — if this ever stops holding, the assertion below is
  // inspecting the wrong object and the pin is worthless.
  assert.notEqual(
    built.bundle.agent,
    built.orchestrator,
    'the claude-cli branch must produce a CliChatAgent, not the orchestrator',
  );
  assert.equal(
    installedGuard(built.bundle.agent),
    guard,
    'the guard passed in deps must reach the constructed CliChatAgent',
  );
});

test('a claude-cli agent without a guard in deps installs none (#1016)', () => {
  const built = buildOrchestratorForAgent(
    { agentId: 'cli', model: 'opus-cli', maxTokens: 100, maxToolIterations: 4 },
    cliDeps(),
  );
  // Hosts that publish no `routineTurnOwnerGuard` service keep the pre-#1016
  // behaviour instead of getting a half-built guard.
  assert.equal(installedGuard(built.bundle.agent), undefined);
});

/**
 * #1087 — the WIRING pin for conversation memory on the subscription-CLI path.
 *
 * `CliChatAgent` composes one stateless prompt per turn, so a history supplier
 * that is never injected means the agent has no memory at all — the reported
 * bug. This reads the tail back OUT of the store the production branch wires,
 * rather than asserting that some function was handed over: a supplier that
 * returns nothing would satisfy the latter and reproduce the bug.
 */
function inMemoryMemoryStore(): MemoryStore {
  const files = new Map<string, string>();
  return {
    list: async (path: string) =>
      [...files.keys()]
        .filter((p) => p.startsWith(`${path}/`))
        .map((p) => ({ virtualPath: p, isDirectory: false, sizeBytes: 0 })),
    fileExists: async (path: string) => files.has(path),
    directoryExists: async (path: string) =>
      [...files.keys()].some((p) => p.startsWith(`${path}/`)),
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    },
    createFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    delete: async (path: string) => {
      files.delete(path);
    },
    rename: async () => {},
  };
}

/** Reads the history supplier the agent was constructed with. */
type TailSupplier = (
  scope: string,
  limit: number,
) => Promise<readonly { userMessage: string; assistantAnswer: string }[] | undefined>;

function installedSessionTail(agent: unknown): TailSupplier | undefined {
  return (agent as { deps?: { sessionTail?: TailSupplier } }).deps?.sessionTail;
}

test('a claude-cli agent replays the chat session store as its tail (#1087)', async () => {
  const built = buildOrchestratorForAgent(
    { agentId: 'cli', model: 'opus-cli', maxTokens: 100, maxToolIterations: 4 },
    { ...cliDeps(), memoryStore: inMemoryMemoryStore() },
  );

  await built.bundle.chatSessionStore.save({
    id: 'sess-1087',
    title: 'chat',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { id: 'u1', role: 'user', content: 'Wer bist du?', startedAt: 1 },
      { id: 'a1', role: 'assistant', content: 'Ich bin dein Assistent.', startedAt: 1 },
      { id: 'u2', role: 'user', content: 'Hund oder Katze?', startedAt: 2 },
      { id: 'a2', role: 'assistant', content: 'Katze.', startedAt: 2 },
      // A trailing unanswered question: dropped defensively, never replayed.
      { id: 'u3', role: 'user', content: 'Fasse unser Gespräch zusammen', startedAt: 3 },
    ],
  });

  await built.bundle.chatSessionStore.save({
    id: 'sess-failed',
    title: 'chat whose only turn failed',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { id: 'u1', role: 'user', content: 'Wer bist du?', startedAt: 1 },
      { id: 'a1', role: 'assistant', content: 'Fehler: upstream 500', startedAt: 1, error: true },
    ],
  });

  // What the web UI PUTs when a tab is created (and on "clear chat").
  await built.bundle.chatSessionStore.save({
    id: 'sess-empty',
    title: 'Neuer Chat',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  });

  // #1071 — a cleared chat a routine has since delivered into: its only
  // message is a proactive delivery, which is not a conversation turn.
  await built.bundle.chatSessionStore.save({
    id: 'sess-proactive-only',
    title: 'Routinen',
    createdAt: 1,
    updatedAt: 3,
    messages: [
      {
        id: 'proactive-r1-3',
        role: 'assistant',
        content: 'Tagesreport',
        startedAt: 3,
        finishedAt: 3,
        proactive: { deliveredAt: 3, routineId: 'r1', routineName: 'Daily report' },
      },
    ],
  });

  const tail = installedSessionTail(built.bundle.agent);
  assert.ok(tail, 'the claude-cli branch must inject a history supplier');

  assert.deepEqual(await tail('sess-1087', 3), [
    { userMessage: 'Wer bist du?', assistantAnswer: 'Ich bin dein Assistent.' },
    { userMessage: 'Hund oder Katze?', assistantAnswer: 'Katze.' },
  ]);
  // Scopes the chat store was never keyed by answer `undefined` — "I cannot
  // read this", which the agent discloses — rather than `[]`, which would pass
  // a Teams conversation off as a brand-new chat.
  assert.equal(await tail('teams-19:abc', 3), undefined);
  assert.equal(await tail('http-default', 3), undefined);
  // A chat id with no document is a LOST write, not a new chat — the web UI
  // PUTs the session when the tab is created. Reading it as "new" would
  // reproduce #1087 without any disclosure. It is logged too, so the gap is
  // visible to an operator and not only to the model.
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    assert.equal(await tail('never-persisted', 3), undefined);
    assert.ok(
      warn.mock.calls.some((c) => String(c.arguments[0]).includes('never-persisted')),
      'a missing chat-session document must be logged with its scope',
    );
  } finally {
    warn.mock.restore();
  }
  // Messages exist but none of them survive into a replayable turn (the chat's
  // only question errored): also a gap the agent has to disclose.
  assert.equal(await tail('sess-failed', 3), undefined);
  // An existing chat with no messages yet IS a genuine first turn — `[]`, not
  // `undefined`, or every new chat's first turn would carry the missing-history
  // note.
  assert.deepEqual(await tail('sess-empty', 3), []);
  // Deliveries alone are no history either: `[]`, not the "history could not
  // be loaded" disclosure.
  assert.deepEqual(await tail('sess-proactive-only', 3), []);
});

/**
 * OM-104 / #1077 — the WIRING pin for the operator-set CLI turn budget.
 *
 * The LLM-access page writes `cli_turn_seconds`; `buildOrchestratorForAgent`
 * is the one place that turns it into the `spawnTimeoutMs` the CLI agent
 * reads. The resolver behind it is pinned in `cliTurnBudget.test.ts`; this
 * pins the hop into the agent, which no test called before #1077. Deleting the
 * spread, or changing its unit or rounding, must fail here.
 */
function installedSpawnTimeout(agent: unknown): number | undefined {
  return (agent as { deps?: { spawnTimeoutMs?: number } }).deps?.spawnTimeoutMs;
}

function hasSpawnTimeoutKey(agent: unknown): boolean {
  const d = (agent as { deps?: object }).deps;
  // Absent deps would make every "no key" check pass vacuously.
  assert.ok(d, 'the built CLI agent must carry its deps');
  return Object.prototype.hasOwnProperty.call(d, 'spawnTimeoutMs');
}

function cliAgentWithBudget(cliTurnSeconds: number | undefined): unknown {
  const built = buildOrchestratorForAgent(
    {
      agentId: 'cli',
      model: 'opus-cli',
      maxTokens: 100,
      maxToolIterations: 4,
      ...(cliTurnSeconds !== undefined ? { cliTurnSeconds } : {}),
    },
    cliDeps(),
  );
  // Same guard as the #1016 pin: the assertion must inspect the CLI agent.
  assert.notEqual(built.bundle.agent, built.orchestrator);
  return built.bundle.agent;
}

test('a claude-cli agent gets the configured turn budget in milliseconds (OM-104)', () => {
  assert.equal(installedSpawnTimeout(cliAgentWithBudget(240)), 240_000);
});

test('a fractional turn budget is truncated, not rounded (OM-104)', () => {
  // 2.5007 s = 2500.7 ms → 2500; Math.round would give 2501.
  assert.equal(installedSpawnTimeout(cliAgentWithBudget(2.5007)), 2500);
});

test('an unset, zero or negative turn budget forwards no key at all (OM-104)', () => {
  // ABSENT, not `undefined`/0 — only then does the environment override stay
  // reachable in `resolveCliSpawnTimeoutMs`.
  for (const seconds of [undefined, 0, -5]) {
    assert.equal(
      hasSpawnTimeoutKey(cliAgentWithBudget(seconds)),
      false,
      `cliTurnSeconds=${String(seconds)} must not install a spawn timeout`,
    );
  }
});

test('a metered agent ignores the CLI turn budget (OM-104)', () => {
  const built = buildOrchestratorForAgent(
    { agentId: 'metered', model: 'm', maxTokens: 100, maxToolIterations: 4, cliTurnSeconds: 240 },
    deps(),
  );
  // The budget exists only on the CLI runtime; the in-process path keeps the
  // orchestrator as its agent.
  assert.equal(built.bundle.agent, built.orchestrator);
  assert.equal(installedSpawnTimeout(built.bundle.agent), undefined);
});

/**
 * #1082 — the WIRING pin for the run-trace / capture-filter tally. The admin
 * route reads ONE instance; a factory that ignored `deps.runTraceStats` would
 * leave every Agent counting into a private tally nobody can read, and the
 * counter would be back to "only visible in the log".
 */
test('every built Agent logs into the shared run-trace tally from deps (#1082)', () => {
  const runTraceStats = new RunTraceOutcomeStats();
  const shared = { ...deps(), runTraceStats };
  const a = buildOrchestratorForAgent(
    { agentId: 'public', model: 'm', maxTokens: 100, maxToolIterations: 4 },
    shared,
  );
  const b = buildOrchestratorForAgent(
    { agentId: 'general', model: 'm', maxTokens: 100, maxToolIterations: 4 },
    shared,
  );
  assert.equal(a.bundle.sessionLogger.runTraceStats, runTraceStats);
  assert.equal(b.bundle.sessionLogger.runTraceStats, runTraceStats);

  // Without one in deps each logger keeps its own (tests, bare hosts).
  const bare = buildOrchestratorForAgent(
    { agentId: 'bare', model: 'm', maxTokens: 100, maxToolIterations: 4 },
    deps(),
  );
  assert.ok(bare.bundle.sessionLogger.runTraceStats instanceof RunTraceOutcomeStats);
  assert.notEqual(bare.bundle.sessionLogger.runTraceStats, runTraceStats);
});
