import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  ChatTurnInput,
  ChatTurnResult,
  SemanticAnswer,
} from '@omadia/channel-sdk';
import type { JobHandler, JobSpec } from '@omadia/plugin-api';

import {
  InMemoryProactiveSenderRegistry,
  type ProactiveSender,
} from '../src/plugins/routines/proactiveSender.js';
import type {
  InsertRoutineRunInput,
  RoutineRun,
  RoutineRunsStore,
} from '../src/plugins/routines/routineRunsStore.js';
import {
  ROUTINES_AGENT_ID,
  RoutineNotFoundError,
  RoutineQuotaExceededError,
  RoutineRunner,
  UnknownChannelError,
  type JobSchedulerLike,
  type OrchestratorLike,
  type RoutineActorScope,
  type RoutineRunnerOptions,
} from '../src/plugins/routines/routineRunner.js';
import { resolveRoutineAgent } from '../src/plugins/routines/routineAgentBinding.js';
import { RoutineNameConflictError } from '../src/plugins/routines/routineStore.js';
import { routineTurnContext } from '../src/plugins/routines/routineTurnContext.js';
import { turnContext } from '@omadia/orchestrator';
import { currentExecutionContext, runInExecutionContext, type ModelExecutionContext } from '@omadia/usage-telemetry';
import type { RoutineOutputTemplate } from '../src/plugins/routines/routineOutputTemplate.js';
import type {
  CreateRoutineInput,
  RecordRunInput,
  Routine,
  RoutineOwner,
  RoutineStatus,
  RoutineStore,
} from '../src/plugins/routines/routineStore.js';

/**
 * Stub scheduler that satisfies the runner's `JobSchedulerLike` surface.
 * Captures handlers and lets tests fire them deterministically. We don't
 * use the real `JobScheduler` here because cron-driven jobs schedule via
 * croner's own `setTimeout`, which our test seam can't reach without
 * reimplementing croner — that's both fragile and orthogonal to the
 * runner's behaviour, which is what we're actually verifying.
 */
class StubScheduler implements JobSchedulerLike {
  private readonly entries = new Map<
    string,
    { agentId: string; spec: JobSpec; handler: JobHandler }
  >();

  register(agentId: string, spec: JobSpec, handler: JobHandler): () => void {
    if (this.entries.has(spec.name)) {
      throw new Error(`StubScheduler: duplicate name '${spec.name}'`);
    }
    this.entries.set(spec.name, { agentId, spec, handler });
    return () => {
      this.entries.delete(spec.name);
    };
  }

  stopForPlugin(agentId: string): void {
    for (const [name, entry] of [...this.entries.entries()]) {
      if (entry.agentId === agentId) this.entries.delete(name);
    }
  }

  list(): ReadonlyArray<{ agentId: string; name: string }> {
    return [...this.entries.entries()].map(([name, e]) => ({
      agentId: e.agentId,
      name,
    }));
  }

  /** Fire a registered job's handler with a non-aborted signal. */
  async fire(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`StubScheduler: no handler for '${name}'`);
    await entry.handler(new AbortController().signal);
  }
}

class InMemoryRoutineStore implements RoutineStore {
  // Public so tests can inspect state directly.
  public readonly rows = new Map<string, Routine>();
  public recordRunCalls: RecordRunInput[] = [];
  private nextId = 1;

  /** Total run count across all delete() invocations — handy for assertions. */
  public deleteCalls = 0;

  // The signature here matches the real RoutineStore for the methods the
  // runner consumes. We don't extend the actual class because its private
  // pg pool field is required by TS — this stub just satisfies the
  // structural shape the runner relies on (duck-typed via the import).
  async create(input: CreateRoutineInput): Promise<Routine> {
    // Mirror the real store's `routines_user_name_unique` constraint so
    // tests can exercise the runner's conflict-reconciliation path
    // (issue #506) without a real Postgres pool.
    const collision = [...this.rows.values()].find(
      (r) =>
        r.tenant === input.tenant &&
        r.userId === input.userId &&
        r.name === input.name,
    );
    if (collision) {
      throw new RoutineNameConflictError(input.name);
    }
    const id = `routine-${this.nextId++}`;
    const now = new Date();
    const routine: Routine = {
      id,
      tenant: input.tenant,
      userId: input.userId,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      channel: input.channel,
      conversationRef: input.conversationRef ?? {},
      status: 'active',
      timeoutMs: input.timeoutMs ?? 600_000,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      outputTemplate: input.outputTemplate ?? null,
      agentSlug: input.agentSlug ?? null,
      agentId: input.agentId ?? null,
      timezone: input.timezone ?? null,
      mcpUserKey: input.mcpUserKey ?? null,
    };
    this.rows.set(id, routine);
    return routine;
  }

  async get(id: string): Promise<Routine | null> {
    return this.rows.get(id) ?? null;
  }

  async getByName(
    tenant: string,
    userId: string,
    name: string,
  ): Promise<Routine | null> {
    return (
      [...this.rows.values()].find(
        (r) => r.tenant === tenant && r.userId === userId && r.name === name,
      ) ?? null
    );
  }

  async listForUser(tenant: string, userId: string): Promise<Routine[]> {
    return [...this.rows.values()].filter(
      (r) => r.tenant === tenant && r.userId === userId,
    );
  }

  async listAllActive(): Promise<Routine[]> {
    return [...this.rows.values()].filter((r) => r.status === 'active');
  }

  async countActiveForUser(tenant: string, userId: string): Promise<number> {
    return [...this.rows.values()].filter(
      (r) => r.tenant === tenant && r.userId === userId && r.status === 'active',
    ).length;
  }

  async setStatus(
    id: string,
    status: RoutineStatus,
    owner?: RoutineOwner,
  ): Promise<Routine | null> {
    const existing = this.rows.get(id);
    if (!existing) return null;
    // #1025 — mirror the SQL predicate: an owner that does not match makes
    // the row invisible, exactly as `WHERE id = $1 AND tenant = $3 AND
    // user_id = $4` would. A stub that ignored `owner` would let a scoping
    // regression pass every runner test.
    if (owner && (existing.tenant !== owner.tenant || existing.userId !== owner.userId)) {
      return null;
    }
    const updated: Routine = { ...existing, status, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async delete(id: string, owner?: RoutineOwner): Promise<boolean> {
    this.deleteCalls += 1;
    const existing = this.rows.get(id);
    if (!existing) return false;
    // #1025 — same owner predicate as setStatus, see the note there.
    if (owner && (existing.tenant !== owner.tenant || existing.userId !== owner.userId)) {
      return false;
    }
    return this.rows.delete(id);
  }

  public bindCalls: Array<{ id: string; agentId: string }> = [];

  async bindAgentId(id: string, agentId: string): Promise<void> {
    this.bindCalls.push({ id, agentId });
    const existing = this.rows.get(id);
    if (existing && !existing.agentId) this.rows.set(id, { ...existing, agentId });
  }

  async pauseForAgent(agentId: string, agentSlug: string, message: string): Promise<string[]> {
    const ids: string[] = [];
    for (const [id, r] of this.rows) {
      if (r.status !== 'active') continue;
      if (r.agentId === agentId || (!r.agentId && r.agentSlug === agentSlug)) {
        this.rows.set(id, { ...r, status: 'paused', lastRunError: message });
        ids.push(id);
      }
    }
    return ids;
  }

  async recordRun(input: RecordRunInput): Promise<void> {
    this.recordRunCalls.push(input);
    const existing = this.rows.get(input.id);
    if (!existing) return;
    this.rows.set(input.id, {
      ...existing,
      lastRunAt: new Date(),
      lastRunStatus: input.status,
      lastRunError: input.error ?? null,
    });
  }
}

/**
 * In-memory `RoutineRunsStore` stub. Captures inserts so tests can assert
 * the trigger marker, run-trace presence, and timing fields.
 */
class InMemoryRoutineRunsStore {
  public readonly inserts: InsertRoutineRunInput[] = [];

  async insert(input: InsertRoutineRunInput): Promise<RoutineRun | null> {
    this.inserts.push(input);
    return null;
  }

  async listForRoutine(): Promise<RoutineRun[]> {
    return [];
  }

  async get(): Promise<RoutineRun | null> {
    return null;
  }
}

interface StubOrchestratorOptions {
  /** Plain text answer the orchestrator returns. Defaults to 'ok'. */
  answerText?: string;
  /** Throws this error instead of returning a result. */
  throwError?: Error;
  /** Synthetic run-trace blob — the runner persists it as JSONB. */
  runTrace?: unknown;
  /** When set, the orchestrator waits on this resolve handle before returning. */
  awaitableHandle?: { resolve?: () => void };
}

function makeStubOrchestrator(opts: StubOrchestratorOptions = {}): {
  orchestrator: OrchestratorLike;
  calls: Array<{ userMessage: string; userId?: string; sessionScope?: string }>;
} {
  const calls: Array<{
    userMessage: string;
    userId?: string;
    sessionScope?: string;
  }> = [];
  const orchestrator: OrchestratorLike = {
    async runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
      calls.push({
        userMessage: input.userMessage,
        userId: input.userId,
        sessionScope: input.sessionScope,
      });
      if (opts.awaitableHandle) {
        await new Promise<void>((resolve) => {
          opts.awaitableHandle!.resolve = resolve;
        });
      }
      if (opts.throwError) throw opts.throwError;
      return {
        answer: opts.answerText ?? 'ok',
        toolCalls: 0,
        iterations: 1,
        ...(opts.runTrace !== undefined
          ? { runTrace: opts.runTrace as ChatTurnResult['runTrace'] }
          : {}),
      };
    },
  };
  return { orchestrator, calls };
}

class StubSender implements ProactiveSender {
  public readonly channel: string;
  public readonly calls: Array<{
    conversationRef: unknown;
    message: SemanticAnswer;
    cardBody?: readonly unknown[];
  }> = [];
  public throwError: Error | undefined;

  constructor(channel = 'teams') {
    this.channel = channel;
  }

  async send(opts: {
    conversationRef: unknown;
    message: SemanticAnswer;
    cardBody?: readonly unknown[];
  }): Promise<void> {
    this.calls.push(opts);
    if (this.throwError) throw this.throwError;
  }
}

const VALID_CRON = '*/30 * * * *';
const TENANT = 'tenant-A';
const USER = 'user-1';

/**
 * #1025 — the scope every routine mutation now requires. These tests own
 * their rows as (TENANT, USER), so scoping as that channel user exercises
 * the same predicate production uses instead of the operator bypass.
 */
const OWNER_SCOPE: RoutineActorScope = {
  kind: 'channel-user',
  tenant: TENANT,
  userId: USER,
};

interface Harness {
  store: InMemoryRoutineStore;
  runsStore: InMemoryRoutineRunsStore;
  scheduler: StubScheduler;
  agentCalls: Array<{
    userMessage: string;
    userId?: string;
    sessionScope?: string;
  }>;
  sender: StubSender;
  senderRegistry: InMemoryProactiveSenderRegistry;
  runner: RoutineRunner;
}

interface MakeHarnessOptions {
  orchestrator?: OrchestratorLike;
  /** Live resolver seam (issue #473). Takes precedence over `orchestrator`;
   *  lets tests flip the chat agent between fires (hot-enable / rotation). */
  getOrchestrator?: (agentSlug: string | null) => OrchestratorLike | undefined;
  agentCallsRef?: Array<{
    userMessage: string;
    userId?: string;
    sessionScope?: string;
  }>;
  sender?: StubSender;
  registerSender?: boolean;
  maxActivePerUser?: number;
  /** #1745 — the agent binding seam. */
  resolveAgent?: RoutineRunnerOptions['resolveAgent'];
  /** When set, every `register()` call throws this error. Used to test the
   *  runner's row-rollback behaviour without depending on real cron parsing. */
  registerThrows?: Error;
}

function makeHarness(options: MakeHarnessOptions = {}): Harness {
  const store = new InMemoryRoutineStore();
  const runsStore = new InMemoryRoutineRunsStore();
  const scheduler = new StubScheduler();
  if (options.registerThrows) {
    const err = options.registerThrows;
    scheduler.register = (() => {
      throw err;
    }) as typeof scheduler.register;
  }
  const stubOrch = options.orchestrator
    ? { orchestrator: options.orchestrator, calls: options.agentCallsRef ?? [] }
    : makeStubOrchestrator();
  const sender = options.sender ?? new StubSender();
  const senderRegistry = new InMemoryProactiveSenderRegistry();
  if (options.registerSender !== false) {
    senderRegistry.register(sender);
  }
  const runner = new RoutineRunner({
    store: store as unknown as RoutineStore,
    runsStore: runsStore as unknown as RoutineRunsStore,
    scheduler,
    getOrchestrator: options.getOrchestrator ?? (() => stubOrch.orchestrator),
    senderRegistry,
    log: () => {},
    maxActivePerUser: options.maxActivePerUser,
    ...(options.resolveAgent ? { resolveAgent: options.resolveAgent } : {}),
  });
  return {
    store,
    runsStore,
    scheduler,
    agentCalls: stubOrch.calls,
    sender,
    senderRegistry,
    runner,
  };
}

const baseInput: CreateRoutineInput = {
  tenant: TENANT,
  userId: USER,
  name: 'demo',
  cron: VALID_CRON,
  prompt: 'Sag hallo',
  channel: 'teams',
  conversationRef: { conversation: { id: 'conv-1' } },
};

describe('RoutineRunner — createRoutine', () => {
  it('persists the row and registers the routine with the scheduler', async () => {
    const h = makeHarness();
    const routine = await h.runner.createRoutine(baseInput);
    assert.equal(routine.status, 'active');
    assert.equal(h.store.rows.size, 1);
    // One job should now be active in the scheduler under the routines agent.
    assert.deepEqual(
      h.scheduler.list().map((entry) => entry.agentId),
      [ROUTINES_AGENT_ID],
    );
  });

  it('rejects creation when the channel has no registered sender', async () => {
    const h = makeHarness({ registerSender: false });
    await assert.rejects(
      () => h.runner.createRoutine(baseInput),
      UnknownChannelError,
    );
    assert.equal(h.store.rows.size, 0);
  });

  it('enforces the per-user quota', async () => {
    const h = makeHarness({ maxActivePerUser: 2 });
    await h.runner.createRoutine({ ...baseInput, name: 'a' });
    await h.runner.createRoutine({ ...baseInput, name: 'b' });
    await assert.rejects(
      () => h.runner.createRoutine({ ...baseInput, name: 'c' }),
      RoutineQuotaExceededError,
    );
  });

  // Issue #506 (reviewer-confirmed gap) — the quota check must not run
  // before the reconciliation check for a user already at capacity. A user
  // at `maxActivePerUser` who retries the identical `createRoutine` call
  // that already brought them there (e.g. their turn's own confirmation
  // was dropped) must reconcile to the existing row, not be told they're
  // out of quota — that's the exact false-negative issue #506 was filed
  // over, just re-surfaced as a different exception type.
  it('reconciles a same-request retry even when the user is already at quota', async () => {
    const h = makeHarness({ maxActivePerUser: 1 });
    const first = await h.runner.createRoutine(baseInput);
    const retry = await h.runner.createRoutine(baseInput);
    assert.equal(retry.id, first.id, 'retry must resolve to the original row');
    assert.equal(h.store.rows.size, 1, 'no duplicate row was created');
  });

  // The quota gate must still apply to a genuinely new routine request —
  // reconciliation is only for retries of an already-existing, already-
  // active routine. A different `name` is a real new-routine request and
  // must not silently bypass the quota check.
  it('still enforces the per-user quota for a genuinely new routine name', async () => {
    const h = makeHarness({ maxActivePerUser: 1 });
    await h.runner.createRoutine(baseInput);
    await assert.rejects(
      () => h.runner.createRoutine({ ...baseInput, name: 'a-different-name' }),
      RoutineQuotaExceededError,
    );
  });

  it('rolls the row back when scheduler.register throws', async () => {
    // Production: JobScheduler validates cron via croner and throws
    // JobValidationError on malformed input. We simulate that here so the
    // unit test stays independent of the real scheduler implementation.
    const h = makeHarness({
      registerThrows: new Error("cron 'not a cron' is invalid"),
    });
    await assert.rejects(
      () => h.runner.createRoutine({ ...baseInput, cron: 'not a cron' }),
      /cron.*invalid/i,
    );
    assert.equal(h.store.rows.size, 0, 'orphan row must be cleaned up');
    assert.equal(
      h.store.deleteCalls,
      1,
      'delete() should be invoked exactly once on rollback',
    );
  });

  // Issue #506 — a retry that lands on the same (tenant, user, name) unique
  // key must reconcile against the row that already exists rather than
  // reporting a failure (the row from the FIRST call already committed;
  // only the confirmation leg back to the caller was ever in doubt).
  it('reconciles a same-request retry instead of reporting a conflict', async () => {
    const h = makeHarness();
    const first = await h.runner.createRoutine(baseInput);
    const retry = await h.runner.createRoutine(baseInput);
    assert.equal(retry.id, first.id, 'retry must resolve to the original row');
    assert.equal(h.store.rows.size, 1, 'no duplicate row was created');
    // Only one scheduler registration — the reconciled retry does not
    // re-register (would throw JobAlreadyRegisteredError against the real
    // scheduler if it tried).
    assert.equal(h.scheduler.list().length, 1);
  });

  it('still reports a conflict when the retry disagrees with the existing routine', async () => {
    const h = makeHarness();
    await h.runner.createRoutine(baseInput);
    await assert.rejects(
      () =>
        h.runner.createRoutine({ ...baseInput, prompt: 'Sag etwas anderes' }),
      RoutineNameConflictError,
    );
    assert.equal(h.store.rows.size, 1, 'the conflicting attempt created nothing');
  });

  // Reviewer-confirmed bug fix: `outputTemplate` is an independently-settable
  // object field on both `Routine` and `CreateRoutineInput` (Phase C output
  // templates) and must be compared, not ignored. A create that agrees on
  // cron/prompt/channel/timeoutMs but asks for a different `outputTemplate`
  // is the caller changing the structured-output template on an existing
  // schedule, not a retry — silently reconciling to the old row would
  // discard the caller's new template while reporting success.
  it('still reports a conflict when the retry differs only in outputTemplate', async () => {
    const h = makeHarness();
    const template: RoutineOutputTemplate = {
      format: 'markdown',
      sections: [
        {
          kind: 'static-markdown',
          text: 'Original',
        },
      ],
    };
    const otherTemplate: RoutineOutputTemplate = {
      format: 'markdown',
      sections: [
        {
          kind: 'static-markdown',
          text: 'Different',
        },
      ],
    };
    await h.runner.createRoutine({ ...baseInput, outputTemplate: template });
    await assert.rejects(
      () =>
        h.runner.createRoutine({
          ...baseInput,
          outputTemplate: otherTemplate,
        }),
      RoutineNameConflictError,
    );
    assert.equal(h.store.rows.size, 1, 'the conflicting attempt created nothing');
  });

  it('reconciles a retry whose outputTemplate is structurally identical', async () => {
    const h = makeHarness();
    const template: RoutineOutputTemplate = {
      format: 'markdown',
      sections: [
        {
          kind: 'static-markdown',
          text: 'Same',
        },
      ],
    };
    const first = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: template,
    });
    // A structurally-equal but distinct object — not the same reference —
    // must still reconcile; the comparison is deep, not reference equality.
    const retry = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: {
        format: 'markdown',
        sections: [
          {
            kind: 'static-markdown',
            text: 'Same',
          },
        ],
      },
    });
    assert.equal(retry.id, first.id, 'retry must resolve to the original row');
    assert.equal(h.store.rows.size, 1, 'no duplicate row was created');
  });

  // Reviewer-confirmed bug fix: `conversationRef` is caller-specified on the
  // cold-start outreach path (`ManageRoutineTool.handleCreate` resolves it
  // from `targetEmail` via `buildEmailColdStartTarget` before calling
  // `createRoutine`), so it must be compared like `outputTemplate`, not
  // ignored. A create that agrees on cron/prompt/channel/timeoutMs/
  // outputTemplate but resolves a DIFFERENT `conversationRef` (e.g. a
  // different `targetEmail`) is a genuine new request aimed at a different
  // recipient — silently reconciling to the existing row would report
  // "created" while the new recipient never gets set up and the routine
  // keeps messaging the original one.
  it('still reports a conflict when the retry resolves a different conversationRef', async () => {
    const h = makeHarness();
    await h.runner.createRoutine({
      ...baseInput,
      conversationRef: { conversation: { id: 'conv-alice' } },
    });
    await assert.rejects(
      () =>
        h.runner.createRoutine({
          ...baseInput,
          conversationRef: { conversation: { id: 'conv-bob' } },
        }),
      RoutineNameConflictError,
    );
    assert.equal(h.store.rows.size, 1, 'the conflicting attempt created nothing');
  });

  it('reconciles a retry whose conversationRef is structurally identical', async () => {
    const h = makeHarness();
    const first = await h.runner.createRoutine({
      ...baseInput,
      conversationRef: { conversation: { id: 'conv-alice' } },
    });
    // A structurally-equal but distinct object — not the same reference —
    // must still reconcile; the comparison is deep, not reference equality.
    const retry = await h.runner.createRoutine({
      ...baseInput,
      conversationRef: { conversation: { id: 'conv-alice' } },
    });
    assert.equal(retry.id, first.id, 'retry must resolve to the original row');
    assert.equal(h.store.rows.size, 1, 'no duplicate row was created');
  });

  // Reviewer-confirmed bug fix: `store.create()` normalizes an omitted
  // `conversationRef` to `{}` before persisting (routineStore.ts stores
  // `JSON.stringify(input.conversationRef ?? {})`, and reads it back the
  // same way), but `isSameRoutineRequest` used to compare the stored `{}`
  // against the RAW retry input with no equivalent `?? {}` normalization —
  // unlike `timeoutMs` and `outputTemplate`, which already apply the same
  // default the store itself uses. A genuine retry of the ordinary
  // (non-cold-start) create path — where `conversationRef` is legitimately
  // `undefined` both times — must still reconcile to the existing row
  // rather than falling through to `RoutineNameConflictError`.
  it('reconciles a retry whose conversationRef is omitted both times', async () => {
    const h = makeHarness();
    const first = await h.runner.createRoutine({
      ...baseInput,
      conversationRef: undefined,
    });
    const retry = await h.runner.createRoutine({
      ...baseInput,
      conversationRef: undefined,
    });
    assert.equal(retry.id, first.id, 'retry must resolve to the original row');
    assert.equal(h.store.rows.size, 1, 'no duplicate row was created');
  });

  // Reviewer-confirmed bug fix: reconciliation must not fire against a
  // paused (or otherwise non-active) existing row, even when every other
  // field matches byte-for-byte. A paused routine is not "my own in-flight
  // retry" — it's a separate, deliberate create call that happens to share
  // a name with something the user already paused. Silently returning the
  // paused row would report `status: 'paused'` as a successful create with
  // no active schedule, which is a worse instance of the exact
  // false-negative/false-positive problem issue #506 was filed to fix.
  it('still reports a conflict when the existing same-name routine is paused', async () => {
    const h = makeHarness();
    const first = await h.runner.createRoutine(baseInput);
    await h.runner.pauseRoutine(first.id, OWNER_SCOPE);

    await assert.rejects(
      () => h.runner.createRoutine(baseInput),
      RoutineNameConflictError,
    );
    assert.equal(h.store.rows.size, 1, 'no new row was created');
    assert.equal(
      h.store.rows.get(first.id)?.status,
      'paused',
      'the existing paused row must be left untouched',
    );
    assert.equal(
      h.scheduler.list().length,
      0,
      'no scheduler registration should have happened',
    );
  });
});

describe('RoutineRunner — start (boot scan)', () => {
  it('registers every active row found at startup', async () => {
    const h = makeHarness();
    await h.runner.createRoutine({ ...baseInput, name: 'a' });
    await h.runner.createRoutine({ ...baseInput, name: 'b' });
    h.runner.stop(); // drop the in-memory schedule but keep DB rows

    assert.equal(h.scheduler.list().length, 0);

    await h.runner.start();
    assert.equal(h.scheduler.list().length, 2);
  });

  it('is idempotent — calling start twice is a no-op', async () => {
    const h = makeHarness();
    await h.runner.createRoutine(baseInput);
    h.runner.stop();

    await h.runner.start();
    await h.runner.start();
    assert.equal(h.scheduler.list().length, 1);
  });
});

describe('RoutineRunner — pause / resume / delete', () => {
  it('pause stops the scheduler entry but keeps the row', async () => {
    const h = makeHarness();
    const r = await h.runner.createRoutine(baseInput);
    assert.equal(h.scheduler.list().length, 1);

    const updated = await h.runner.pauseRoutine(r.id, OWNER_SCOPE);
    assert.equal(updated.status, 'paused');
    assert.equal(h.scheduler.list().length, 0);
    assert.equal(h.store.rows.size, 1);
  });

  it('resume re-registers a paused routine', async () => {
    const h = makeHarness();
    const r = await h.runner.createRoutine(baseInput);
    await h.runner.pauseRoutine(r.id, OWNER_SCOPE);

    const resumed = await h.runner.resumeRoutine(r.id, OWNER_SCOPE);
    assert.equal(resumed.status, 'active');
    assert.equal(h.scheduler.list().length, 1);
  });

  it('pause / resume / delete throw RoutineNotFoundError on unknown id', async () => {
    const h = makeHarness();
    await assert.rejects(
      () => h.runner.pauseRoutine('missing', OWNER_SCOPE),
      RoutineNotFoundError,
    );
    await assert.rejects(
      () => h.runner.resumeRoutine('missing', OWNER_SCOPE),
      RoutineNotFoundError,
    );
  });

  it('delete clears both the row and the scheduler entry', async () => {
    const h = makeHarness();
    const r = await h.runner.createRoutine(baseInput);
    const ok = await h.runner.deleteRoutine(r.id, OWNER_SCOPE);
    assert.equal(ok, true);
    assert.equal(h.store.rows.size, 0);
    assert.equal(h.scheduler.list().length, 0);
  });
});

describe('RoutineRunner — run-once delivery path', () => {
  it('invokes the orchestrator and forwards the answer to the sender', async () => {
    const stub = makeStubOrchestrator({ answerText: 'cron output' });
    const sender = new StubSender();
    const h = makeHarness({
      orchestrator: stub.orchestrator,
      agentCallsRef: stub.calls,
      sender,
    });
    const routine = await h.runner.createRoutine(baseInput);

    await h.scheduler.fire(routine.id);

    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.userMessage, baseInput.prompt);
    assert.equal(stub.calls[0]!.userId, USER);
    assert.match(stub.calls[0]!.sessionScope ?? '', /^routine:/);

    assert.equal(sender.calls.length, 1);
    assert.equal(sender.calls[0]!.message.text, 'cron output');
    assert.deepEqual(sender.calls[0]!.conversationRef, baseInput.conversationRef);

    // Backwards-compat last_run_* path
    assert.equal(h.store.recordRunCalls.length, 1);
    assert.equal(h.store.recordRunCalls[0]!.status, 'ok');
    assert.equal(h.store.recordRunCalls[0]!.error ?? null, null);

    // Per-run history append: cron trigger, success, fields populated
    assert.equal(h.runsStore.inserts.length, 1);
    const ins = h.runsStore.inserts[0]!;
    assert.equal(ins.routineId, routine.id);
    assert.equal(ins.trigger, 'cron');
    assert.equal(ins.status, 'ok');
    assert.equal(ins.errorMessage ?? null, null);
    assert.equal(ins.prompt, baseInput.prompt);
    assert.equal(ins.answer, 'cron output');
    assert.equal(ins.iterations, 1);
    assert.equal(ins.toolCalls, 0);
    assert.equal(ins.tenant, baseInput.tenant);
    assert.equal(ins.userId, baseInput.userId);
  });

  it('persists the run-trace JSONB blob when the orchestrator returned one', async () => {
    const trace = { scope: 'routine:x', iterations: 3, orchestratorToolCalls: [] };
    const stub = makeStubOrchestrator({ answerText: 'ok', runTrace: trace });
    const h = makeHarness({
      orchestrator: stub.orchestrator,
      agentCallsRef: stub.calls,
    });
    const routine = await h.runner.createRoutine(baseInput);

    await h.scheduler.fire(routine.id);

    assert.equal(h.runsStore.inserts.length, 1);
    assert.deepEqual(h.runsStore.inserts[0]!.runTrace, trace);
  });

  it('records error when the sender throws but does not rethrow', async () => {
    const stub = makeStubOrchestrator({ answerText: 'output' });
    const sender = new StubSender();
    sender.throwError = new Error('teams adapter expired');
    const h = makeHarness({
      orchestrator: stub.orchestrator,
      agentCallsRef: stub.calls,
      sender,
    });
    const routine = await h.runner.createRoutine(baseInput);

    await h.scheduler.fire(routine.id);

    assert.equal(h.store.recordRunCalls.length, 1);
    assert.equal(h.store.recordRunCalls[0]!.status, 'error');
    assert.match(
      h.store.recordRunCalls[0]!.error ?? '',
      /teams adapter expired/,
    );

    // The run-trace insert still records the failure so the operator-UI
    // can surface a "delivery failed but agent finished" row.
    assert.equal(h.runsStore.inserts.length, 1);
    assert.equal(h.runsStore.inserts[0]!.status, 'error');
    assert.match(
      h.runsStore.inserts[0]!.errorMessage ?? '',
      /teams adapter expired/,
    );
  });

  it('skips delivery when the routine got paused between schedule and trigger', async () => {
    const stub = makeStubOrchestrator();
    const sender = new StubSender();
    const h = makeHarness({
      orchestrator: stub.orchestrator,
      agentCallsRef: stub.calls,
      sender,
    });
    const routine = await h.runner.createRoutine(baseInput);

    // Mark paused directly in the store, simulating a window where the
    // scheduler had already armed but pauseRoutine landed before the timer
    // dispose was processed.
    const existing = h.store.rows.get(routine.id);
    if (existing) {
      h.store.rows.set(routine.id, { ...existing, status: 'paused' });
    }

    await h.scheduler.fire(routine.id);

    assert.equal(stub.calls.length, 0, 'orchestrator must not be invoked');
    assert.equal(sender.calls.length, 0, 'sender must not be called');
    // #1071 — a skipped fire is not a run: recording it as `ok` overwrote
    // the last_run_error that explains an auto-pause.
    assert.equal(h.runsStore.inserts.length, 0, 'no run history row');
    assert.equal(h.store.recordRunCalls.length, 0, 'last_run_* untouched');
  });

  it('marks manually-triggered runs with trigger=manual', async () => {
    const stub = makeStubOrchestrator({ answerText: 'manual answer' });
    const sender = new StubSender();
    const h = makeHarness({
      orchestrator: stub.orchestrator,
      agentCallsRef: stub.calls,
      sender,
    });
    const routine = await h.runner.createRoutine(baseInput);

    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);

    assert.equal(stub.calls.length, 1);
    assert.equal(sender.calls.length, 1);
    assert.equal(h.runsStore.inserts.length, 1);
    assert.equal(h.runsStore.inserts[0]!.trigger, 'manual');
    assert.equal(h.runsStore.inserts[0]!.status, 'ok');
  });

  it('a run is the turn of the agent that runs it, whatever context the caller had (spec 2042 §5.10)', async () => {
    const seen: (ModelExecutionContext | undefined)[] = [];
    const orchestrator: OrchestratorLike = {
      runTurn: async () => {
        seen.push(currentExecutionContext());
        return { answer: 'ok', toolCalls: 0, iterations: 1 };
      },
      speaker: { kind: 'agent', agentId: 'id-lena', slug: 'lena', displayName: 'Lena' },
    };
    const h = makeHarness({ orchestrator });
    const routine = await h.runner.createRoutine(baseInput);
    // "Run now" from another agent's chat turn, and from the HTTP route.
    await runInExecutionContext({ kind: 'agent_turn', ownerId: 'other', agentSlug: 'other' }, () =>
      h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE),
    );
    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    assert.deepEqual(seen, [
      { kind: 'agent_turn', ownerId: 'lena', agentSlug: 'lena' },
      { kind: 'agent_turn', ownerId: 'lena', agentSlug: 'lena' },
    ]);
  });
});

/**
 * Phase C.2 — Raw tool-result capture bridge.
 *
 * The runner is responsible for opting templated routines into the capture
 * path: instantiate a fresh `Map<toolName, unknown>`, expose it via
 * `routineTurnContext.withRawToolResults`, and inject a
 * `captureRawToolResult` callback into the orchestrator's outer
 * `turnContext` so the inner `runTurn` inherits it.
 *
 * These tests use a custom stub orchestrator that simulates a tool
 * dispatch — reading `turnContext.current()?.captureRawToolResult` and
 * invoking it with a synthetic raw result. That verifies the parent →
 * child ALS forwarding works without spinning up the real orchestrator.
 */
describe('RoutineRunner — Phase C.2 raw tool-result capture', () => {
  const TEMPLATE: RoutineOutputTemplate = {
    format: 'markdown',
    sections: [
      {
        kind: 'data-table',
        sourceTool: 'query_odoo_hr',
        columns: [{ label: 'Mitarbeiter', field: 'name' }],
      },
    ],
  };

  function makeCapturingOrchestrator(synthetic: {
    toolName: string;
    rawResult: string;
  }): {
    orchestrator: OrchestratorLike;
    seenCapture: { called: boolean; toolName?: string; rawResult?: string };
    seenRoutineMap: { map?: Map<string, unknown> };
  } {
    const seenCapture: {
      called: boolean;
      toolName?: string;
      rawResult?: string;
    } = { called: false };
    const seenRoutineMap: { map?: Map<string, unknown> } = {};
    const orchestrator: OrchestratorLike = {
      async runTurn(): Promise<ChatTurnResult> {
        // Snapshot what the inner code sees — the runner's bridge must
        // have established both ALS scopes by the time `runTurn` runs.
        const capture = turnContext.current()?.captureRawToolResult;
        seenRoutineMap.map = routineTurnContext.currentRawToolResults();
        if (capture) {
          seenCapture.called = true;
          seenCapture.toolName = synthetic.toolName;
          seenCapture.rawResult = synthetic.rawResult;
          capture(synthetic.toolName, synthetic.rawResult);
        }
        return { answer: 'ok', toolCalls: 1, iterations: 1 };
      },
    };
    return { orchestrator, seenCapture, seenRoutineMap };
  }

  it('non-templated routine: no capture callback, no raw map in ALS', async () => {
    const cap = makeCapturingOrchestrator({
      toolName: 'query_odoo_hr',
      rawResult: '{"absences":[]}',
    });
    const h = makeHarness({ orchestrator: cap.orchestrator });
    const routine = await h.runner.createRoutine(baseInput);

    await h.scheduler.fire(routine.id);

    assert.equal(cap.seenCapture.called, false);
    assert.equal(cap.seenRoutineMap.map, undefined);
  });

  it('templated routine: capture callback fires and writes into the routine map', async () => {
    const cap = makeCapturingOrchestrator({
      toolName: 'query_odoo_hr',
      rawResult: '{"absences":[{"name":"Anna Müller"}]}',
    });
    const h = makeHarness({ orchestrator: cap.orchestrator });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: TEMPLATE,
    });

    await h.scheduler.fire(routine.id);

    assert.equal(cap.seenCapture.called, true);
    assert.ok(cap.seenRoutineMap.map !== undefined);
    assert.equal(
      cap.seenRoutineMap.map!.get('query_odoo_hr'),
      '{"absences":[{"name":"Anna Müller"}]}',
    );
  });

  it('templated routine: raw-result map is fresh per turn (no cross-run bleed)', async () => {
    const observed: Array<Map<string, unknown> | undefined> = [];
    const orchestrator: OrchestratorLike = {
      async runTurn(): Promise<ChatTurnResult> {
        const map = routineTurnContext.currentRawToolResults();
        observed.push(map);
        // Mutate so the next turn would see leftover state if the ALS
        // failed to isolate.
        const capture = turnContext.current()?.captureRawToolResult;
        capture?.('query_odoo_hr', `turn-${observed.length}`);
        return { answer: 'ok', toolCalls: 1, iterations: 1 };
      },
    };
    const h = makeHarness({ orchestrator });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: TEMPLATE,
    });

    await h.scheduler.fire(routine.id);
    await h.scheduler.fire(routine.id);

    assert.equal(observed.length, 2);
    assert.notEqual(observed[0], observed[1]);
    assert.equal(observed[0]!.get('query_odoo_hr'), 'turn-1');
    assert.equal(observed[1]!.get('query_odoo_hr'), 'turn-2');
  });

  it('templated routine: ALS scope clears after runTurn — caller-side map retains the captures', async () => {
    const cap = makeCapturingOrchestrator({
      toolName: 'query_knowledge_graph',
      rawResult: '[{"id":"node-1"}]',
    });
    const h = makeHarness({ orchestrator: cap.orchestrator });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: TEMPLATE,
    });

    await h.scheduler.fire(routine.id);

    // After scheduler.fire resolves, the outer ALS scope has exited, so a
    // top-level read sees nothing — but the runner's caller-side map (the
    // one we passed into `withRawToolResults`) still holds the captures.
    assert.equal(routineTurnContext.currentRawToolResults(), undefined);
    assert.ok(cap.seenRoutineMap.map !== undefined);
    assert.equal(
      cap.seenRoutineMap.map!.get('query_knowledge_graph'),
      '[{"id":"node-1"}]',
    );
  });
});

/**
 * Phase C.5 — End-to-end templated-routine pipeline.
 *
 * The runner is responsible for the full template path:
 *
 *   1. Append `buildSlotDirective` to the routine prompt.
 *   2. Run `runTurn` with raw-tool-result capture active.
 *   3. Parse the LLM's JSON response via `parseSlotResponse`.
 *   4. Render the final markdown via `renderRoutineTemplate`.
 *   5. Replace `result.answer` with the rendered markdown.
 *
 * These tests use a stub orchestrator that simulates the LLM's tool
 * use + JSON response so we can verify the runner's wiring without
 * spinning up the real Claude client.
 */
describe('RoutineRunner — Phase C.5 templated end-to-end pipeline', () => {
  const HR_TEMPLATE: RoutineOutputTemplate = {
    format: 'markdown',
    sections: [
      { kind: 'narrative-slot', id: 'intro', hint: 'Ein Satz Einleitung.' },
      {
        kind: 'data-table',
        sourceTool: 'query_odoo_hr',
        sourcePath: 'absences',
        title: 'Abwesenheiten',
        columns: [
          { label: 'Mitarbeiter', field: 'name' },
          { label: 'Abteilung', field: 'department' },
        ],
      },
      { kind: 'narrative-slot', id: 'summary', hint: '2-3 Bullets.' },
    ],
  };

  it('augments prompt with slot directive, captures tool, and renders final markdown', async () => {
    let receivedPrompt = '';
    const orchestrator: OrchestratorLike = {
      async runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
        receivedPrompt = input.userMessage;
        // Simulate the LLM having called query_odoo_hr (capture fires).
        const capture = turnContext.current()?.captureRawToolResult;
        capture?.(
          'query_odoo_hr',
          '{"absences":[{"name":"Anna Müller","department":"PHP"},{"name":"Ben Lee","department":"Ops"}]}',
        );
        // LLM produces a slot JSON response.
        return {
          answer: JSON.stringify({
            slots: {
              intro: 'Heute, 15. Mai 2026, sind 2 Mitarbeiter abwesend.',
              summary: '- Beide aus dem ExtSvc-Team\n- Anna kehrt am 18.05. zurück',
            },
          }),
          toolCalls: 1,
          iterations: 2,
        };
      },
    };
    const sender = new StubSender();
    const h = makeHarness({ orchestrator, sender });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      prompt: 'Erzeuge den HR-Tagesbericht.',
      outputTemplate: HR_TEMPLATE,
    });

    await h.scheduler.fire(routine.id);

    // Prompt augmentation: directive appended after the routine prompt.
    assert.match(receivedPrompt, /^Erzeuge den HR-Tagesbericht\./);
    assert.match(receivedPrompt, /Antworte ausschließlich mit einem einzigen JSON-Objekt/);
    assert.match(receivedPrompt, /"intro": "\.\.\."/);
    assert.match(receivedPrompt, /"summary": "\.\.\."/);

    // The delivered message is the rendered template, not the LLM's JSON.
    assert.equal(sender.calls.length, 1);
    const text = sender.calls[0]!.message.text!;
    assert.match(text, /Heute, 15\. Mai 2026, sind 2 Mitarbeiter abwesend\./);
    assert.match(text, /## Abwesenheiten/);
    assert.match(text, /\| Mitarbeiter \| Abteilung \|/);
    assert.match(text, /\| Anna Müller \| PHP \|/);
    assert.match(text, /\| Ben Lee \| Ops \|/);
    assert.match(text, /Beide aus dem ExtSvc-Team/);
    // No JSON leakage in the user-facing output.
    assert.doesNotMatch(text, /"slots"/);
  });

  it('falls back to empty slots when LLM response is not parseable JSON', async () => {
    const logLines: string[] = [];
    const orchestrator: OrchestratorLike = {
      async runTurn(): Promise<ChatTurnResult> {
        const capture = turnContext.current()?.captureRawToolResult;
        capture?.(
          'query_odoo_hr',
          '{"absences":[{"name":"Anna Müller","department":"PHP"}]}',
        );
        return {
          answer: 'Sorry, kann ich nicht.',
          toolCalls: 1,
          iterations: 1,
        };
      },
    };
    const sender = new StubSender();
    const store = new InMemoryRoutineStore();
    const runsStore = new InMemoryRoutineRunsStore();
    const scheduler = new StubScheduler();
    const senderRegistry = new InMemoryProactiveSenderRegistry();
    senderRegistry.register(sender);
    const runner = new RoutineRunner({
      store: store as unknown as RoutineStore,
      runsStore: runsStore as unknown as RoutineRunsStore,
      scheduler,
      getOrchestrator: () => orchestrator,
      senderRegistry,
      log: (msg) => {
        logLines.push(msg);
      },
    });
    const routine = await runner.createRoutine({
      ...baseInput,
      outputTemplate: HR_TEMPLATE,
    });

    await scheduler.fire(routine.id);

    // Data section + table still ship (raw capture is independent of LLM
    // narrative success).
    assert.equal(sender.calls.length, 1);
    const text = sender.calls[0]!.message.text!;
    assert.match(text, /## Abwesenheiten/);
    assert.match(text, /\| Anna Müller \| PHP \|/);
    // Narrative slots collapsed to nothing (empty-string slots are
    // silently skipped by the renderer).
    assert.doesNotMatch(text, /Heute, 15\. Mai/);
    // Operator-visible diagnostic.
    assert.ok(
      logLines.some((l) => /slot-parse failed/.test(l)),
      'expected a slot-parse-failed log line',
    );
  });

  it('persists the rendered markdown as the run answer (not the LLM JSON)', async () => {
    const orchestrator: OrchestratorLike = {
      async runTurn(): Promise<ChatTurnResult> {
        const capture = turnContext.current()?.captureRawToolResult;
        capture?.(
          'query_odoo_hr',
          '{"absences":[{"name":"Carla","department":"QA"}]}',
        );
        return {
          answer: JSON.stringify({
            slots: { intro: 'Heute eine Person abwesend.', summary: '- Carla bis 20.05.' },
          }),
          toolCalls: 1,
          iterations: 1,
        };
      },
    };
    const h = makeHarness({ orchestrator });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: HR_TEMPLATE,
    });

    await h.scheduler.fire(routine.id);

    // The per-run history blob carries the rendered markdown, not the JSON.
    assert.equal(h.runsStore.inserts.length, 1);
    const persisted = h.runsStore.inserts[0]!.answer!;
    assert.match(persisted, /## Abwesenheiten/);
    assert.match(persisted, /\| Carla \| QA \|/);
    assert.doesNotMatch(persisted, /"slots"/);
  });

  it('skips slot directive when template has no required slots (data-only)', async () => {
    const DATA_ONLY: RoutineOutputTemplate = {
      format: 'markdown',
      sections: [
        {
          kind: 'data-table',
          sourceTool: 'query_odoo_hr',
          sourcePath: 'absences',
          title: 'Stand heute',
          columns: [{ label: 'Name', field: 'name' }],
        },
        { kind: 'static-markdown', text: '_Stand: Odoo_' },
      ],
    };
    let receivedPrompt = '';
    const orchestrator: OrchestratorLike = {
      async runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
        receivedPrompt = input.userMessage;
        const capture = turnContext.current()?.captureRawToolResult;
        capture?.('query_odoo_hr', '{"absences":[{"name":"Dora"}]}');
        return {
          answer: 'whatever the LLM said',
          toolCalls: 1,
          iterations: 1,
        };
      },
    };
    const h = makeHarness({ orchestrator });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      prompt: 'Status heute.',
      outputTemplate: DATA_ONLY,
    });

    await h.scheduler.fire(routine.id);

    // No directive appended — prompt is verbatim.
    assert.equal(receivedPrompt, 'Status heute.');
    const text = h.sender.calls[0]!.message.text!;
    assert.match(text, /## Stand heute/);
    assert.match(text, /\| Dora \|/);
    assert.match(text, /_Stand: Odoo_/);
    // LLM's free-text answer is discarded.
    assert.doesNotMatch(text, /whatever the LLM said/);
  });
});

/**
 * Phase C.6 — Adaptive-card dispatch path.
 *
 * When a templated routine declares `format: 'adaptive-card'`, the
 * runner produces Adaptive Card body items AND a markdown fallback.
 * The sender receives BOTH: `message.text` (markdown rendering of
 * the same template, for non-card channels) and `cardBody` (the items,
 * for channels that can render rich cards).
 */
describe('RoutineRunner — Phase C.6 adaptive-card path', () => {
  const HR_CARD_TEMPLATE: RoutineOutputTemplate = {
    format: 'adaptive-card',
    sections: [
      { kind: 'narrative-slot', id: 'intro' },
      {
        kind: 'data-table',
        sourceTool: 'query_odoo_hr',
        sourcePath: 'absences',
        title: 'Abwesenheiten',
        columns: [
          { label: 'Mitarbeiter', field: 'name' },
          { label: 'Abteilung', field: 'department' },
        ],
      },
    ],
  };

  it('attaches cardBody to sender.send and ships a markdown text fallback', async () => {
    const orchestrator: OrchestratorLike = {
      async runTurn(): Promise<ChatTurnResult> {
        const capture = turnContext.current()?.captureRawToolResult;
        capture?.(
          'query_odoo_hr',
          '{"absences":[{"name":"Anna Müller","department":"PHP"}]}',
        );
        return {
          answer: JSON.stringify({
            slots: { intro: 'Heute eine Person abwesend.' },
          }),
          toolCalls: 1,
          iterations: 1,
        };
      },
    };
    const h = makeHarness({ orchestrator });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: HR_CARD_TEMPLATE,
    });

    await h.scheduler.fire(routine.id);

    assert.equal(h.sender.calls.length, 1);
    const call = h.sender.calls[0]!;

    // Markdown fallback is present in message.text so non-card channels
    // still see something useful.
    const text = call.message.text;
    assert.match(text, /Heute eine Person abwesend\./);
    assert.match(text, /## Abwesenheiten/);
    assert.match(text, /\| Anna Müller \| PHP \|/);

    // Card body items shipped separately. The renderer produced 3 items:
    // intro TextBlock + title TextBlock + Table.
    assert.ok(call.cardBody !== undefined, 'cardBody should be set');
    assert.equal(call.cardBody!.length, 3);
    assert.equal(
      (call.cardBody![0] as Record<string, unknown>)['text'],
      'Heute eine Person abwesend.',
    );
    assert.equal(
      (call.cardBody![1] as Record<string, unknown>)['text'],
      'Abwesenheiten',
    );
    assert.equal((call.cardBody![2] as Record<string, unknown>)['type'], 'Table');
  });

  it('non-templated routines do not set cardBody', async () => {
    const orchestrator: OrchestratorLike = {
      async runTurn(): Promise<ChatTurnResult> {
        return { answer: 'plain answer', toolCalls: 0, iterations: 1 };
      },
    };
    const h = makeHarness({ orchestrator });
    const routine = await h.runner.createRoutine(baseInput);

    await h.scheduler.fire(routine.id);

    assert.equal(h.sender.calls.length, 1);
    assert.equal(h.sender.calls[0]!.cardBody, undefined);
  });

  it('markdown-format templates do not set cardBody (only text)', async () => {
    const MARKDOWN_TEMPLATE: RoutineOutputTemplate = {
      format: 'markdown',
      sections: [{ kind: 'narrative-slot', id: 'intro' }],
    };
    const orchestrator: OrchestratorLike = {
      async runTurn(): Promise<ChatTurnResult> {
        return {
          answer: JSON.stringify({ slots: { intro: 'Hi.' } }),
          toolCalls: 0,
          iterations: 1,
        };
      },
    };
    const h = makeHarness({ orchestrator });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: MARKDOWN_TEMPLATE,
    });

    await h.scheduler.fire(routine.id);

    assert.equal(h.sender.calls.length, 1);
    assert.equal(h.sender.calls[0]!.cardBody, undefined);
    assert.equal(h.sender.calls[0]!.message.text, 'Hi.');
  });
});

/**
 * Issue #473 — the runner resolves the chat agent LIVE per fire (never
 * captured at construction), so routines hot-enable the moment the Setup
 * Wizard key save publishes chatAgent@1, and a key rotation swaps
 * orchestrator instances without a restart. Keyless fires record an
 * `error` run naming the missing key.
 */
describe('live chat-agent resolution (issue #473)', () => {
  it('records a chat-unavailable error run when no orchestrator resolves — before the sender lookup', async () => {
    // Pre-key BOTH the chat agent and the channel senders are dark
    // (channel plugins require chatAgent@^1). The recorded error must
    // name the missing key, not the missing sender — so the routine is
    // registered without a sender and the chat-agent check has to win.
    const h = makeHarness({
      getOrchestrator: () => undefined,
      registerSender: false,
    });
    // createRoutine guards on a registered sender; seed the row directly
    // and let resumeRoutine do the scheduler registration (it only warns
    // on a missing sender).
    const row = await h.store.create(baseInput);
    await h.runner.resumeRoutine(row.id, OWNER_SCOPE);

    await h.scheduler.fire(row.id);

    assert.equal(h.runsStore.inserts.length, 1);
    assert.equal(h.runsStore.inserts[0]!.status, 'error');
    assert.match(
      h.runsStore.inserts[0]!.errorMessage ?? '',
      /chat agent unavailable.*LLM API key/i,
    );
    assert.doesNotMatch(
      h.runsStore.inserts[0]!.errorMessage ?? '',
      /no proactive sender/,
    );
    assert.equal(h.store.recordRunCalls.length, 1);
    assert.equal(h.store.recordRunCalls[0]!.status, 'error');
  });

  it('hot-enables: a fire after the resolver starts returning an orchestrator succeeds without re-registration', async () => {
    const stub = makeStubOrchestrator({ answerText: 'routines are live' });
    let current: OrchestratorLike | undefined;
    const h = makeHarness({ getOrchestrator: () => current });
    const routine = await h.runner.createRoutine(baseInput);

    // Keyless fire → error run, orchestrator never invoked.
    await h.scheduler.fire(routine.id);
    assert.equal(h.runsStore.inserts[0]!.status, 'error');
    assert.equal(h.sender.calls.length, 0);

    // Key saved → chatAgent@1 published. Same scheduler entry, next fire
    // just works — no restart, no re-init.
    current = stub.orchestrator;
    await h.scheduler.fire(routine.id);

    assert.equal(h.runsStore.inserts.length, 2);
    assert.equal(h.runsStore.inserts[1]!.status, 'ok');
    assert.equal(stub.calls.length, 1);
    assert.equal(h.sender.calls.length, 1);
    assert.equal(h.sender.calls[0]!.message.text, 'routines are live');
  });

  it('key rotation: each fire uses the orchestrator instance current at fire time', async () => {
    const a = makeStubOrchestrator({ answerText: 'from A' });
    const b = makeStubOrchestrator({ answerText: 'from B' });
    let current: OrchestratorLike | undefined = a.orchestrator;
    const h = makeHarness({ getOrchestrator: () => current });
    const routine = await h.runner.createRoutine(baseInput);

    await h.scheduler.fire(routine.id);
    current = b.orchestrator; // reactivate published a NEW bundle
    await h.scheduler.fire(routine.id);

    assert.equal(a.calls.length, 1);
    assert.equal(b.calls.length, 1);
    assert.equal(h.sender.calls[0]!.message.text, 'from A');
    assert.equal(h.sender.calls[1]!.message.text, 'from B');
    assert.deepEqual(
      h.runsStore.inserts.map((r) => r.status),
      ['ok', 'ok'],
    );
  });

  it('chatAgentAvailable() mirrors the resolver', async () => {
    let current: OrchestratorLike | undefined;
    const h = makeHarness({ getOrchestrator: () => current });
    assert.equal(h.runner.chatAgentAvailable(), false);
    current = makeStubOrchestrator().orchestrator;
    assert.equal(h.runner.chatAgentAvailable(), true);
  });
});

describe('#1598 — a routine runs on the orchestrator that created it', () => {
  it('passes the stored agentSlug to the resolver on every fire', async () => {
    const hr = makeStubOrchestrator({ answerText: 'from hr' });
    const asked: Array<string | null> = [];
    const h = makeHarness({
      getOrchestrator: (slug) => {
        asked.push(slug);
        return slug === 'hr' ? hr.orchestrator : undefined;
      },
    });
    const routine = await h.runner.createRoutine({ ...baseInput, agentSlug: 'hr' });
    await h.scheduler.fire(routine.id);
    assert.ok(asked.includes('hr'));
    assert.equal(h.runsStore.inserts[0]!.status, 'ok');
    assert.equal(hr.calls.length, 1);
  });

  it('an orchestrator that no longer exists records an error run, never a wider one', async () => {
    const wide = makeStubOrchestrator({ answerText: 'from the ungated bundle' });
    const h = makeHarness({
      getOrchestrator: (slug) => (slug === null ? wide.orchestrator : undefined),
    });
    const routine = await h.runner.createRoutine({ ...baseInput, agentSlug: 'deleted-agent' });
    await h.scheduler.fire(routine.id);
    assert.equal(h.runsStore.inserts[0]!.status, 'error');
    assert.equal(wide.calls.length, 0);
  });

  it('a routine without an owner (pre-0005) asks for the standard orchestrator (null)', async () => {
    const asked: Array<string | null> = [];
    const std = makeStubOrchestrator();
    const h = makeHarness({
      getOrchestrator: (slug) => {
        asked.push(slug);
        return std.orchestrator;
      },
    });
    const routine = await h.runner.createRoutine(baseInput);
    await h.scheduler.fire(routine.id);
    assert.ok(asked.length > 0 && asked.every((a) => a === null), `asked: ${JSON.stringify(asked)}`);
    assert.equal(h.runsStore.inserts[0]!.status, 'ok');
  });
});


describe('#1746 / #1747 / #1748 — run control: cancel, timeout signal, one run at a time', () => {
  /** An orchestrator whose turn waits until the test releases it. */
  function gatedOrchestrator(): {
    orchestrator: OrchestratorLike;
    started: Promise<void>;
    release: () => void;
    seenSignals: Array<AbortSignal | undefined>;
    runTurnCalls: () => number;
  } {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      markStarted = r;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seenSignals: Array<AbortSignal | undefined> = [];
    let calls = 0;
    const orchestrator: OrchestratorLike = {
      async runTurn(): Promise<ChatTurnResult> {
        calls += 1;
        seenSignals.push(turnContext.current()?.abortSignal);
        markStarted();
        await gate;
        return { answer: 'late answer', toolCalls: 0, iterations: 1 };
      },
    };
    return { orchestrator, started, release, seenSignals, runTurnCalls: () => calls };
  }

  it('a pause during a run records `cancelled`, stops the turn signal and delivers nothing', async () => {
    const gated = gatedOrchestrator();
    const sender = new StubSender();
    const h = makeHarness({ orchestrator: gated.orchestrator, sender });
    const routine = await h.runner.createRoutine(baseInput);

    const run = h.scheduler.fire(routine.id);
    await gated.started;
    assert.equal(h.runner.isRunning(routine.id), true);
    await h.runner.pauseRoutine(routine.id, OWNER_SCOPE);
    assert.equal(gated.seenSignals[0]?.aborted, true, 'the turn sees the cancellation');
    gated.release();
    await run;

    assert.equal(sender.calls.length, 0);
    assert.equal(h.runsStore.inserts.length, 1);
    assert.equal(h.runsStore.inserts[0]!.status, 'cancelled');
    assert.match(h.runsStore.inserts[0]!.errorMessage ?? '', /paused while it ran/);
    assert.equal(h.runner.isRunning(routine.id), false);
  });

  it('a delete during a run writes no run row (its history went with it) and delivers nothing', async () => {
    const gated = gatedOrchestrator();
    const sender = new StubSender();
    const h = makeHarness({ orchestrator: gated.orchestrator, sender });
    const routine = await h.runner.createRoutine(baseInput);

    const run = h.scheduler.fire(routine.id);
    await gated.started;
    await h.runner.deleteRoutine(routine.id, OWNER_SCOPE);
    gated.release();
    await run;

    assert.equal(sender.calls.length, 0);
    assert.equal(h.runsStore.inserts.length, 0);
    assert.equal(h.store.recordRunCalls.length, 0);
  });

  it('a routine paused elsewhere while the turn ran is not delivered (status re-read before delivery)', async () => {
    const gated = gatedOrchestrator();
    const sender = new StubSender();
    const h = makeHarness({ orchestrator: gated.orchestrator, sender });
    const routine = await h.runner.createRoutine(baseInput);

    const run = h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    await gated.started;
    // Another instance (or the harness) paused the row; this runner was not told.
    h.store.rows.set(routine.id, { ...h.store.rows.get(routine.id)!, status: 'paused' });
    gated.release();
    await run;

    assert.equal(sender.calls.length, 0);
    assert.equal(h.runsStore.inserts[0]!.status, 'cancelled');
    assert.equal(h.runsStore.inserts[0]!.trigger, 'manual');
  });

  it('a manual run while one is in flight is refused; a cron firing then is skipped', async () => {
    const gated = gatedOrchestrator();
    const h = makeHarness({ orchestrator: gated.orchestrator });
    const routine = await h.runner.createRoutine(baseInput);

    const first = h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    await gated.started;
    await assert.rejects(
      h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE),
      (err: Error) => err.name === 'RoutineRunInProgressError',
    );
    await h.scheduler.fire(routine.id);
    gated.release();
    await first;

    assert.equal(gated.runTurnCalls(), 1, 'exactly one turn ran');
    assert.equal(h.runsStore.inserts.length, 1);
    assert.equal(h.runsStore.inserts[0]!.status, 'ok');
  });

  it('a manual run hands the turn an abort signal (its timeout), like a scheduled one', async () => {
    const gated = gatedOrchestrator();
    const h = makeHarness({ orchestrator: gated.orchestrator });
    const routine = await h.runner.createRoutine(baseInput);
    const run = h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    await gated.started;
    assert.ok(gated.seenSignals[0], 'the turn context carries an abort signal');
    assert.equal(gated.seenSignals[0]!.aborted, false);
    gated.release();
    await run;
  });

  it('resuming a routine that is already active and armed does not re-register it', async () => {
    const h = makeHarness();
    const routine = await h.runner.createRoutine(baseInput);
    let registers = 0;
    const original = h.scheduler.register.bind(h.scheduler);
    h.scheduler.register = (agentId, spec, handler) => {
      registers += 1;
      return original(agentId, spec, handler);
    };
    await h.runner.resumeRoutine(routine.id, OWNER_SCOPE);
    assert.equal(registers, 0);
  });

  it('effectiveTimeoutMs raises a stored timeout below the floor', async () => {
    const { effectiveTimeoutMs, MIN_ROUTINE_TIMEOUT_MS } = await import('../src/plugins/routines/routineRunControl.js');
    assert.equal(effectiveTimeoutMs(1000), MIN_ROUTINE_TIMEOUT_MS);
    assert.equal(effectiveTimeoutMs(600_000), 600_000);
  });
});

describe('#1763 — a routine on an agent whose tool loop runs outside the kernel (subscription CLI)', () => {
  it('runs through the agent chat agent, delivers its published answer as-is and records unknown counts', async () => {
    let runTurnCalls = 0;
    const chatInputs: ChatTurnInput[] = [];
    const orchestrator: OrchestratorLike = {
      runTurn(): Promise<ChatTurnResult> {
        runTurnCalls += 1;
        return Promise.reject(new Error('claude-cli provider supports only forced single-tool structured output'));
      },
      chat(input: ChatTurnInput): Promise<SemanticAnswer> {
        chatInputs.push(input);
        return Promise.resolve({ text: 'cli answer', turnId: 'turn-cli' });
      },
    };
    const sender = new StubSender();
    const h = makeHarness({ orchestrator, sender });
    const routine = await h.runner.createRoutine(baseInput);

    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);

    assert.equal(runTurnCalls, 0, 'the tool-less in-process orchestrator is never used');
    assert.equal(chatInputs.length, 1);
    assert.equal(chatInputs[0]!.sessionScope, `routine:${routine.id}`);
    assert.equal(chatInputs[0]!.userId, USER);
    assert.equal(sender.calls.length, 1);
    assert.equal(sender.calls[0]!.message.text, 'cli answer');
    const run = h.runsStore.inserts[0]!;
    assert.equal(run.status, 'ok');
    assert.equal(run.answer, 'cli answer');
    assert.equal(run.iterations, null);
    assert.equal(run.toolCalls, null);
  });
});


describe('#1744 / #1745 — a routine is bound to its agent by id', () => {
  /** A registry whose slug `seo` is held by `holder`. */
  const registryWith = (holder: { id: string; slug: string } | undefined) => ({
    get: (slug: string) => (holder && slug === holder.slug ? { agent: holder } : undefined),
  });

  it('binds the creating agent by id and runs while that agent holds the slug', async () => {
    let holder: { id: string; slug: string } | undefined = { id: 'agent-1', slug: 'seo' };
    const sender = new StubSender();
    const h = makeHarness({ sender, resolveAgent: (r) => resolveRoutineAgent(r, registryWith(holder)) });
    const routine = await h.runner.createRoutine({ ...baseInput, agentSlug: 'seo' });
    assert.equal(routine.agentId, 'agent-1');
    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    assert.equal(sender.calls.length, 1);

    // The agent is deleted and a new one takes the slug: the routine does not follow.
    holder = { id: 'agent-2', slug: 'seo' };
    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    assert.equal(sender.calls.length, 1, 'nothing delivered by the new agent');
    const last = h.runsStore.inserts.at(-1)!;
    assert.equal(last.status, 'error');
    assert.match(last.errorMessage ?? '', /no agent can run this routine: its agent 'seo' was deleted, and the agent that now has that name is a different one/);
  });

  it('a disabled or deleted agent is named instead of the LLM-key hint', async () => {
    const h = makeHarness({ resolveAgent: (r) => resolveRoutineAgent(r, registryWith(undefined)) });
    const routine = await h.runner.createRoutine({ ...baseInput, agentSlug: 'seo' });
    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    const run = h.runsStore.inserts[0]!;
    assert.match(run.errorMessage ?? '', /its agent 'seo' is disabled or deleted/);
    assert.doesNotMatch(run.errorMessage ?? '', /API key/);
    assert.match(h.runner.agentProblemOf(routine) ?? '', /disabled or deleted/);
  });

  it('a routine without an agent does not fall back to the default agent', async () => {
    const h = makeHarness({ resolveAgent: (r) => resolveRoutineAgent(r, registryWith({ id: 'a', slug: 'other' })) });
    const routine = await h.runner.createRoutine(baseInput);
    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    assert.equal(h.agentCalls.length, 0);
    assert.match(h.runsStore.inserts[0]!.errorMessage ?? '', /not bound to an agent/);
  });

  it('binds a pre-migration row (no agent id) on its next run', async () => {
    const h = makeHarness({ resolveAgent: (r) => resolveRoutineAgent(r, registryWith({ id: 'agent-1', slug: 'seo' })) });
    const routine = await h.runner.createRoutine({ ...baseInput, agentSlug: 'seo' });
    h.store.rows.set(routine.id, { ...h.store.rows.get(routine.id)!, agentId: null });
    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    assert.deepEqual(h.store.bindCalls, [{ id: routine.id, agentId: 'agent-1' }]);
  });

  it('pauses the routines of an agent that ends service, with the reason on the routine', async () => {
    const h = makeHarness({ resolveAgent: (r) => resolveRoutineAgent(r, registryWith({ id: 'agent-1', slug: 'seo' })) });
    const a = await h.runner.createRoutine({ ...baseInput, agentSlug: 'seo' });
    const b = await h.runner.createRoutine({ ...baseInput, name: 'other', agentSlug: 'seo' });
    const n = await h.runner.pauseRoutinesOfAgent({ id: 'agent-1', slug: 'seo' }, "paused: its agent 'SEO' was disabled");
    assert.equal(n, 2);
    for (const id of [a.id, b.id]) {
      const row = h.store.rows.get(id)!;
      assert.equal(row.status, 'paused');
      assert.match(row.lastRunError ?? '', /was disabled/);
    }
    assert.equal(h.scheduler.list().length, 0, 'both unregistered');
  });
});

describe('#1770 / #1771 / #1772 — a routine turn is unattended and outside any routines principal', () => {
  it('runs unattended with its time, and without the clicking turn\'s principal (no manage_routine)', async () => {
    const seen: Array<{ input: ChatTurnInput; principal: unknown }> = [];
    const orchestrator: OrchestratorLike = {
      runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
        seen.push({ input, principal: routineTurnContext.current() });
        return Promise.resolve({ answer: 'ok', toolCalls: 0, iterations: 1 });
      },
    };
    const h = makeHarness({ orchestrator });
    const routine = await h.runner.createRoutine({ ...baseInput, timezone: 'Europe/Berlin' });

    // A smart-card "run now" inside a chat turn that carries a routines principal.
    await routineTurnContext.run(
      { tenant: TENANT, userId: USER, channel: 'teams', conversationRef: {} },
      () => h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE),
    );

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.principal, undefined, 'manage_routine is not offered in the run');
    assert.equal(seen[0]!.input.unattended, true);
    assert.match(seen[0]!.input.extraSystemHint ?? '', /scheduled run of a routine\. Current time: \d{4}-\d\d-\d\d \d\d:\d\d \(Europe\/Berlin\)/);
  });
});

describe('#1759 / #1760 / #1761 — template run outcomes', () => {
  it('a static-only template delivers its text without running a turn', async () => {
    const stub = makeStubOrchestrator();
    const sender = new StubSender();
    const h = makeHarness({ orchestrator: stub.orchestrator, agentCallsRef: stub.calls, sender });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: { format: 'markdown', sections: [{ kind: 'static-markdown', text: 'Stand-up in 5 Minuten.' }] },
    });
    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    assert.equal(stub.calls.length, 0, 'no paid turn');
    assert.equal(sender.calls[0]!.message.text, 'Stand-up in 5 Minuten.');
    assert.equal(h.runsStore.inserts[0]!.status, 'ok');
  });

  it('an answer of [[nothing]] ends the run silent, with nothing delivered', async () => {
    const stub = makeStubOrchestrator({ answerText: '[[nothing]]' });
    const sender = new StubSender();
    const h = makeHarness({ orchestrator: stub.orchestrator, agentCallsRef: stub.calls, sender });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: { format: 'markdown', sections: [{ kind: 'narrative-slot', id: 'intro' }] },
    });
    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    assert.equal(sender.calls.length, 0);
    assert.equal(h.runsStore.inserts[0]!.status, 'silent');
    assert.equal(h.runsStore.inserts[0]!.errorMessage, null);
  });

  it('records template problems on a delivered run and keeps the slots the model did write', async () => {
    const stub = makeStubOrchestrator({ answerText: '{"slots":{"intro":"Hallo"}}' });
    const sender = new StubSender();
    const h = makeHarness({ orchestrator: stub.orchestrator, agentCallsRef: stub.calls, sender });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: {
        format: 'markdown',
        sections: [
          { kind: 'narrative-slot', id: 'intro' },
          { kind: 'narrative-slot', id: 'outro' },
          { kind: 'data-list', sourceTool: 'query_hr', itemTemplate: '{{name}}', emptyText: 'none' },
        ],
      },
    });
    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    assert.equal(sender.calls[0]!.message.text, 'Hallo\n\nnone');
    const run = h.runsStore.inserts[0]!;
    assert.equal(run.status, 'ok');
    assert.match(run.errorMessage ?? '', /^template: the model's slot response was incomplete \(missing required slot 'outro'\)/);
    assert.match(run.errorMessage ?? '', /'query_hr' was not called/);
  });
});

describe('#1776 — what a routine run cost', () => {
  it('records the metered cost on the run, also for a failed turn, and books a manual run on its trigger', async () => {
    const { addMeteredCost } = await import('@omadia/usage-telemetry');
    const booked: Array<{ id: string; cost: number }> = [];
    let fail = false;
    const orchestrator: OrchestratorLike = {
      runTurn(): Promise<ChatTurnResult> {
        addMeteredCost(0.25);
        if (fail) return Promise.reject(new Error('provider down'));
        return Promise.resolve({ answer: 'ok', toolCalls: 1, iterations: 1 });
      },
    };
    const store = new InMemoryRoutineStore();
    const runsStore = new InMemoryRoutineRunsStore();
    const scheduler = new StubScheduler();
    const senderRegistry = new InMemoryProactiveSenderRegistry();
    senderRegistry.register(new StubSender());
    const runner = new RoutineRunner({
      store: store as unknown as RoutineStore,
      runsStore: runsStore as unknown as RoutineRunsStore,
      scheduler,
      getOrchestrator: () => orchestrator,
      senderRegistry,
      bookManualRunCost: (id, cost) => {
        booked.push({ id, cost });
        return Promise.resolve();
      },
      log: () => {},
    });
    const routine = await runner.createRoutine(baseInput);

    await runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    assert.equal(runsStore.inserts[0]!.costUsd, 0.25);
    assert.deepEqual(booked, [{ id: routine.id, cost: 0.25 }]);

    await scheduler.fire(routine.id);
    assert.equal(runsStore.inserts[1]!.costUsd, 0.25);
    assert.equal(booked.length, 1, 'a cron run is settled by its firing, not booked again');

    fail = true;
    await runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    assert.equal(runsStore.inserts[2]!.status, 'error');
    assert.equal(runsStore.inserts[2]!.costUsd, 0.25, 'a failed turn still spent');
  });
});
describe('review fixes — withheld answers and the pause reason', () => {
  it('CLI path: a withheld slot answer goes out as the notice, never as the rendered template or card', async () => {
    const notice = { text: 'Diese Antwort wurde zurückgehalten.', speaker: { kind: 'system' as const }, systemNotice: { kind: 'identity_guard', text: 'Diese Antwort wurde zurückgehalten.' } };
    const orchestrator: OrchestratorLike = {
      runTurn: () => Promise.reject(new Error('not on the CLI path')),
      chat: () => Promise.resolve(notice as unknown as SemanticAnswer),
    };
    const sender = new StubSender();
    const h = makeHarness({ orchestrator, sender });
    const routine = await h.runner.createRoutine({
      ...baseInput,
      outputTemplate: {
        format: 'adaptive-card',
        sections: [
          { kind: 'narrative-slot', id: 'intro' },
          { kind: 'static-markdown', text: 'SECRET TABLE' },
        ],
      },
    });
    await h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    assert.equal(sender.calls.length, 1);
    assert.equal(sender.calls[0]!.message.text, notice.text);
    assert.equal(sender.calls[0]!.cardBody, undefined);
    assert.doesNotMatch(JSON.stringify(sender.calls[0]), /SECRET TABLE/);
  });

  it('a cancelled run keeps the reason the routine was paused with', async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const startedP = new Promise<void>((r) => (started = r));
    const orchestrator: OrchestratorLike = {
      runTurn: async () => {
        started();
        await new Promise<void>((r) => (release = r));
        return { answer: 'x', toolCalls: 0, iterations: 1 };
      },
    };
    const h = makeHarness({ orchestrator });
    const routine = await h.runner.createRoutine({ ...baseInput, agentSlug: 'seo', agentId: 'a1' });
    const run = h.runner.triggerRoutineNow(routine.id, OWNER_SCOPE);
    await startedP;
    await h.runner.pauseRoutinesOfAgent({ id: 'a1', slug: 'seo' }, "paused: its agent 'SEO' was disabled");
    release();
    await run;
    assert.equal(h.runsStore.inserts[0]!.status, 'cancelled');
    assert.match(h.store.rows.get(routine.id)!.lastRunError ?? '', /its agent 'SEO' was disabled/);
  });
});
describe('RoutineRunner — MCP identity of a run (#1907, ADR-0206)', () => {
  function observingOrchestrator(seen: Array<{ key?: string; unattended?: boolean }>): OrchestratorLike {
    return {
      async runTurn(): Promise<ChatTurnResult> {
        const ctx = turnContext.current();
        seen.push({
          ...(ctx?.mcpUserKey !== undefined ? { key: ctx.mcpUserKey } : {}),
          ...(ctx?.mcpUnattended !== undefined ? { unattended: ctx.mcpUnattended } : {}),
        });
        return { answer: 'ok', toolCalls: 0, iterations: 1 };
      },
    };
  }

  it("runs as the owner's recorded MCP identity, unattended, on both branches", async () => {
    for (const outputTemplate of [null, TEMPLATE_FOR_IDENTITY]) {
      const seen: Array<{ key?: string; unattended?: boolean }> = [];
      const h = makeHarness({ orchestrator: observingOrchestrator(seen) });
      const routine = await h.runner.createRoutine({
        ...baseInput,
        outputTemplate,
        mcpUserKey: 'owner-sub-123',
      });
      // An ambient turn of somebody else must not lend its identity.
      await turnContext.run(
        { turnId: 'other-turn', turnDate: '2026-11-26', mcpUserKey: 'someone-else' },
        () => h.scheduler.fire(routine.id),
      );
      assert.deepEqual(seen, [{ key: 'owner-sub-123', unattended: true }]);
    }
  });

  it('a routine without a recorded identity runs with none', async () => {
    const seen: Array<{ key?: string; unattended?: boolean }> = [];
    const h = makeHarness({ orchestrator: observingOrchestrator(seen) });
    const routine = await h.runner.createRoutine(baseInput);
    await turnContext.run(
      { turnId: 'other-turn', turnDate: '2026-11-26', mcpUserKey: 'someone-else' },
      () => h.scheduler.fire(routine.id),
    );
    assert.deepEqual(seen, [{ unattended: true }]);
  });
});

// A model slot, so the templated branch runs a turn (a static-only template
// skips it, #1760).
const TEMPLATE_FOR_IDENTITY: RoutineOutputTemplate = {
  format: 'markdown',
  sections: [
    { kind: 'static-markdown', text: 'Report' },
    { kind: 'narrative-slot', id: 'intro' },
  ],
};
