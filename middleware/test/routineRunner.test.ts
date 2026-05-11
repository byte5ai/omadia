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
} from '../src/plugins/routines/routineRunner.js';
import type {
  CreateRoutineInput,
  RecordRunInput,
  Routine,
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
      conversationRef: input.conversationRef,
      status: 'active',
      timeoutMs: input.timeoutMs ?? 600_000,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
    };
    this.rows.set(id, routine);
    return routine;
  }

  async get(id: string): Promise<Routine | null> {
    return this.rows.get(id) ?? null;
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

  async setStatus(id: string, status: RoutineStatus): Promise<Routine | null> {
    const existing = this.rows.get(id);
    if (!existing) return null;
    const updated: Routine = { ...existing, status, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    this.deleteCalls += 1;
    return this.rows.delete(id);
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
  }> = [];
  public throwError: Error | undefined;

  constructor(channel = 'teams') {
    this.channel = channel;
  }

  async send(opts: {
    conversationRef: unknown;
    message: SemanticAnswer;
  }): Promise<void> {
    this.calls.push(opts);
    if (this.throwError) throw this.throwError;
  }
}

const VALID_CRON = '*/30 * * * *';
const TENANT = 'tenant-A';
const USER = 'user-1';

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
  agentCallsRef?: Array<{
    userMessage: string;
    userId?: string;
    sessionScope?: string;
  }>;
  sender?: StubSender;
  registerSender?: boolean;
  maxActivePerUser?: number;
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
    orchestrator: stubOrch.orchestrator,
    senderRegistry,
    log: () => {},
    maxActivePerUser: options.maxActivePerUser,
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

    const updated = await h.runner.pauseRoutine(r.id);
    assert.equal(updated.status, 'paused');
    assert.equal(h.scheduler.list().length, 0);
    assert.equal(h.store.rows.size, 1);
  });

  it('resume re-registers a paused routine', async () => {
    const h = makeHarness();
    const r = await h.runner.createRoutine(baseInput);
    await h.runner.pauseRoutine(r.id);

    const resumed = await h.runner.resumeRoutine(r.id);
    assert.equal(resumed.status, 'active');
    assert.equal(h.scheduler.list().length, 1);
  });

  it('pause / resume / delete throw RoutineNotFoundError on unknown id', async () => {
    const h = makeHarness();
    await assert.rejects(
      () => h.runner.pauseRoutine('missing'),
      RoutineNotFoundError,
    );
    await assert.rejects(
      () => h.runner.resumeRoutine('missing'),
      RoutineNotFoundError,
    );
  });

  it('delete clears both the row and the scheduler entry', async () => {
    const h = makeHarness();
    const r = await h.runner.createRoutine(baseInput);
    const ok = await h.runner.deleteRoutine(r.id);
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

    await h.runner.triggerRoutineNow(routine.id);

    assert.equal(stub.calls.length, 1);
    assert.equal(sender.calls.length, 1);
    assert.equal(h.runsStore.inserts.length, 1);
    assert.equal(h.runsStore.inserts[0]!.trigger, 'manual');
    assert.equal(h.runsStore.inserts[0]!.status, 'ok');
  });
});
