import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool } from 'pg';

import { InMemoryProactiveSenderRegistry } from '../src/plugins/routines/proactiveSender.js';
import { createRoutinesIntegration } from '../src/plugins/routines/integration.js';
import type { RoutinesHandle } from '../src/plugins/routines/initRoutines.js';
import {
  ManageRoutineTool,
  ROUTINE_NO_CONTEXT_ERROR,
  type ManageRoutineContext,
} from '../src/plugins/routines/manageRoutineTool.js';
import {
  RoutineNotFoundError,
  RoutineRunner,
  type JobSchedulerLike,
  type OrchestratorLike,
  type RoutineActorScope,
} from '../src/plugins/routines/routineRunner.js';
import { RoutineStore } from '../src/plugins/routines/routineStore.js';
import type {
  CreateRoutineInput,
  Routine,
  RoutineOwner,
  RoutineStatus,
} from '../src/plugins/routines/routineStore.js';
import type { RoutineRunsStore } from '../src/plugins/routines/routineRunsStore.js';
import { routineTurnContext } from '../src/plugins/routines/routineTurnContext.js';

/**
 * #1025 — `manage_routine` resolved the turn context for `create` and
 * `list` but not for `pause`, `resume` and `delete`. Those three passed a
 * bare id to a runner that filtered on nothing, so knowing an id was
 * enough to act on another tenant's routine. Routine ids are uuids and
 * `list` is scoped, so the barrier was that an id had to leak — obscurity,
 * not authorization.
 *
 * These tests drive the REAL tool, the REAL runner and the REAL smart-card
 * integration. The only stub is the store, and it mirrors the SQL owner
 * predicate rather than ignoring it — a stub that ignored `owner` would let
 * the whole scoping change be reverted with every test still green, which
 * is the failure mode this file exists to rule out.
 */

const OWNER: RoutineOwner = { tenant: 'tenant-A', userId: 'user-1' };
const OTHER: RoutineOwner = { tenant: 'tenant-B', userId: 'user-9' };

const OWNER_CTX: ManageRoutineContext = {
  tenant: OWNER.tenant,
  userId: OWNER.userId,
  channel: 'teams',
  conversationRef: { conversation: { id: 'conv-1' } },
};

/** The scope a channel turn for OWNER produces. */
const OWNER_SCOPE: RoutineActorScope = {
  kind: 'channel-user',
  tenant: OWNER.tenant,
  userId: OWNER.userId,
};

/** A deterministic, schema-valid v4 uuid for the nth seeded row. */
function uuidForSeq(n: number): string {
  const tail = String(n).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}

function matchesOwner(row: Routine, owner?: RoutineOwner): boolean {
  return (
    owner === undefined ||
    (row.tenant === owner.tenant && row.userId === owner.userId)
  );
}

/** Store stub whose owner predicate mirrors the scoped SQL. */
class ScopedStoreStub {
  readonly rows = new Map<string, Routine>();
  private seq = 1;

  /**
   * `manage_routine` validates `id` as a uuid, so a readable stub id like
   * `routine-1` fails input validation before any scoping runs and every
   * assertion below would pass for the wrong reason.
   */
  seed(owner: RoutineOwner, over: Partial<Routine> = {}): Routine {
    const id = over.id ?? uuidForSeq(this.seq++);
    const now = new Date();
    const row: Routine = {
      id,
      tenant: owner.tenant,
      userId: owner.userId,
      name: `routine-${id}`,
      cron: '*/30 * * * *',
      prompt: 'Sag hallo',
      channel: 'teams',
      conversationRef: { conversation: { id: `conv-${id}` } },
      status: 'active',
      timeoutMs: 600_000,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
      outputTemplate: null,
      ...over,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async create(input: CreateRoutineInput): Promise<Routine> {
    return this.seed(
      { tenant: input.tenant, userId: input.userId },
      { name: input.name, cron: input.cron, prompt: input.prompt },
    );
  }

  async get(id: string): Promise<Routine | null> {
    return this.rows.get(id) ?? null;
  }

  async getByName(): Promise<Routine | null> {
    return null;
  }

  async listForUser(tenant: string, userId: string): Promise<Routine[]> {
    return [...this.rows.values()].filter(
      (r) => r.tenant === tenant && r.userId === userId,
    );
  }

  async listAllActive(): Promise<Routine[]> {
    return [...this.rows.values()].filter((r) => r.status === 'active');
  }

  async listAll(): Promise<Routine[]> {
    return [...this.rows.values()];
  }

  async countActiveForUser(): Promise<number> {
    return 0;
  }

  async setStatus(
    id: string,
    status: RoutineStatus,
    owner?: RoutineOwner,
  ): Promise<Routine | null> {
    const row = this.rows.get(id);
    if (!row || !matchesOwner(row, owner)) return null;
    const updated: Routine = { ...row, status, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async delete(id: string, owner?: RoutineOwner): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || !matchesOwner(row, owner)) return false;
    return this.rows.delete(id);
  }

  async recordRun(): Promise<void> {}
}

/** Scheduler stub that records which routine ids were unregistered. */
class TrackingScheduler implements JobSchedulerLike {
  readonly registered = new Set<string>();
  readonly unregistered: string[] = [];

  register(_agentId: string, spec: { name: string }): () => void {
    this.registered.add(spec.name);
    return () => {
      this.registered.delete(spec.name);
      this.unregistered.push(spec.name);
    };
  }

  stopForPlugin(): void {}

  list(): ReadonlyArray<{ agentId: string; name: string }> {
    return [];
  }
}

interface Harness {
  store: ScopedStoreStub;
  scheduler: TrackingScheduler;
  runner: RoutineRunner;
  tool: ManageRoutineTool;
  runs: string[];
}

function makeHarness(
  resolveContext: () => ManageRoutineContext | undefined = () => OWNER_CTX,
): Harness {
  const store = new ScopedStoreStub();
  const scheduler = new TrackingScheduler();
  const runs: string[] = [];
  const orchestrator: OrchestratorLike = {
    async runTurn(input: { userMessage: string }) {
      runs.push(input.userMessage);
      return { text: 'ok' };
    },
  } as unknown as OrchestratorLike;
  const senderRegistry = new InMemoryProactiveSenderRegistry();
  senderRegistry.register({
    channel: 'teams',
    async send() {},
  } as never);
  const runner = new RoutineRunner({
    store: store as unknown as RoutineStore,
    runsStore: {
      async insert() {
        return null;
      },
      async listForRoutine() {
        return [];
      },
      async get() {
        return null;
      },
    } as unknown as RoutineRunsStore,
    scheduler,
    getOrchestrator: () => orchestrator,
    senderRegistry,
    log: () => {},
  });
  const tool = new ManageRoutineTool({ runner, resolveContext });
  return { store, scheduler, runner, tool, runs };
}

describe('#1025 manage_routine — pause/resume/delete refuse without a turn context', () => {
  for (const action of ['pause', 'resume', 'delete'] as const) {
    it(`${action} returns the no-context error instead of acting on a bare id`, async () => {
      const h = makeHarness(() => undefined);
      const row = h.store.seed(OWNER);

      const out = await h.tool.handle({ action, id: row.id });

      assert.equal(out, ROUTINE_NO_CONTEXT_ERROR);
      // The row is untouched: still present, still active.
      assert.equal(h.store.rows.get(row.id)?.status, 'active');
      assert.equal(h.store.rows.size, 1);
    });
  }
});

describe('#1025 manage_routine — another tenant\'s id is not actionable', () => {
  it('pause reports not-found and leaves the foreign routine active', async () => {
    const h = makeHarness();
    const foreign = h.store.seed(OTHER);

    const out = await h.tool.handle({ action: 'pause', id: foreign.id });

    assert.match(out, /^Error: /);
    assert.equal(h.store.rows.get(foreign.id)?.status, 'active');
  });

  it('resume reports not-found and leaves the foreign routine paused', async () => {
    const h = makeHarness();
    const foreign = h.store.seed(OTHER, { status: 'paused' });

    const out = await h.tool.handle({ action: 'resume', id: foreign.id });

    assert.match(out, /^Error: /);
    assert.equal(h.store.rows.get(foreign.id)?.status, 'paused');
  });

  it('delete reports not_found and the foreign routine survives', async () => {
    const h = makeHarness();
    const foreign = h.store.seed(OTHER);

    const out = await h.tool.handle({ action: 'delete', id: foreign.id });

    assert.equal(JSON.parse(out).action, 'not_found');
    assert.equal(h.store.rows.has(foreign.id), true);
  });

  it('the refusal does not disclose that the id exists', async () => {
    const h = makeHarness();
    const foreign = h.store.seed(OTHER);

    const onForeign = await h.tool.handle({ action: 'pause', id: foreign.id });
    const onAbsent = await h.tool.handle({
      action: 'pause',
      id: '11111111-1111-4111-8111-111111111111',
    });

    // Same shape for "exists but not yours" and "does not exist": anything
    // else turns the error channel into an existence oracle.
    assert.equal(
      onForeign.replace(foreign.id, 'ID'),
      onAbsent.replace('11111111-1111-4111-8111-111111111111', 'ID'),
    );
  });
});

describe('#1025 manage_routine — the owner still acts on their own routines', () => {
  it('pause, resume and delete all succeed for the caller\'s own row', async () => {
    const h = makeHarness();
    const own = h.store.seed(OWNER);

    const paused = await h.tool.handle({ action: 'pause', id: own.id });
    assert.equal(JSON.parse(paused).action, 'paused');
    assert.equal(h.store.rows.get(own.id)?.status, 'paused');

    const resumed = await h.tool.handle({ action: 'resume', id: own.id });
    assert.equal(JSON.parse(resumed).action, 'resumed');
    assert.equal(h.store.rows.get(own.id)?.status, 'active');

    const deleted = await h.tool.handle({ action: 'delete', id: own.id });
    assert.equal(JSON.parse(deleted).action, 'deleted');
    assert.equal(h.store.rows.has(own.id), false);
  });
});

describe('#1025 runner — trigger and delete are scoped too', () => {
  it('triggerRoutineNow refuses a foreign id and never runs the turn', async () => {
    const h = makeHarness();
    const foreign = h.store.seed(OTHER);

    await assert.rejects(
      () => h.runner.triggerRoutineNow(foreign.id, OWNER_SCOPE),
      RoutineNotFoundError,
    );
    // The decisive assertion: a run would have delivered into the OTHER
    // tenant's conversationRef.
    assert.equal(h.runs.length, 0);
  });

  it('a refused delete does not disarm the foreign routine\'s schedule', async () => {
    const h = makeHarness();
    const foreign = h.store.seed(OTHER);
    await h.runner.resumeRoutine(foreign.id, { kind: 'operator' });
    assert.equal(h.scheduler.registered.has(foreign.id), true);

    const ok = await h.runner.deleteRoutine(foreign.id, OWNER_SCOPE);

    assert.equal(ok, false);
    // The old order unregistered BEFORE deleting, so a cross-tenant id
    // silently stopped someone else's cron while the row survived — a
    // routine that looks active in `list` and never fires again.
    assert.deepEqual(h.scheduler.unregistered, []);
    assert.equal(h.scheduler.registered.has(foreign.id), true);
  });

  it('an operator scope still reaches across tenants, by design', async () => {
    const h = makeHarness();
    const foreign = h.store.seed(OTHER);

    const paused = await h.runner.pauseRoutine(foreign.id, {
      kind: 'operator',
    });

    assert.equal(paused.status, 'paused');
  });
});

/**
 * The suites above stub the store, so they prove the tool/runner/integration
 * layers PASS a scope. They cannot prove the store USES it: a stub that
 * mirrors the owner predicate stays green even if the real SQL drops it.
 * (Measured: removing the predicate from `routineStore` left all 14 green.)
 *
 * This suite closes that hole without Postgres, using the recording-pool
 * pattern from `publicMcpKeyBindingsAdmin.test.ts`: capture the statement,
 * then follow each `$n` the SQL names into the parameter array, so a swap
 * on either side is caught by the other.
 */
describe('#1025 routineStore — the owner predicate is in the SQL, not just the caller', () => {
  interface Recorded {
    text: string;
    values: unknown[];
  }

  function recordingStore(): { store: RoutineStore; stmts: Recorded[] } {
    const stmts: Recorded[] = [];
    const pool = {
      async query(text: string, values?: unknown[]) {
        stmts.push({ text, values: values ?? [] });
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    return { store: new RoutineStore({ pool, log: () => {} }), stmts };
  }

  const flat = (sql: string): string => sql.replace(/\s+/g, ' ');

  /** The value the driver substitutes for the `$n` this pattern captures. */
  function boundTo(stmt: Recorded, pattern: RegExp): unknown {
    const match = pattern.exec(flat(stmt.text));
    assert.ok(match, `SQL does not match ${pattern}: ${flat(stmt.text)}`);
    return stmt.values[Number(match[1]) - 1];
  }

  it('setStatus binds the owner tenant and user_id into its WHERE clause', async () => {
    const { store, stmts } = recordingStore();

    await store.setStatus('r1', 'paused', OWNER);

    const stmt = stmts[0];
    assert.ok(stmt);
    assert.equal(boundTo(stmt, /tenant = \$(\d+)/), OWNER.tenant);
    assert.equal(boundTo(stmt, /user_id = \$(\d+)/), OWNER.userId);
  });

  it('delete binds the owner tenant and user_id into its WHERE clause', async () => {
    const { store, stmts } = recordingStore();

    await store.delete('r1', OWNER);

    const stmt = stmts[0];
    assert.ok(stmt);
    assert.equal(boundTo(stmt, /tenant = \$(\d+)/), OWNER.tenant);
    assert.equal(boundTo(stmt, /user_id = \$(\d+)/), OWNER.userId);
  });

  it('omits the predicate entirely for an unscoped (operator) call', async () => {
    const { store, stmts } = recordingStore();

    await store.setStatus('r1', 'paused');
    await store.delete('r1');

    for (const stmt of stmts) {
      assert.doesNotMatch(flat(stmt.text), /tenant = \$/);
      assert.doesNotMatch(flat(stmt.text), /user_id = \$/);
    }
  });
});

describe('#1025 smart-card actions — the second door is scoped as well', () => {
  function integrationFor(h: Harness) {
    return createRoutinesIntegration({
      store: h.store as unknown as RoutineStore,
      runner: h.runner,
    } as unknown as RoutinesHandle);
  }

  it('refuses a foreign id even though the card carries it', async () => {
    const h = makeHarness();
    const foreign = h.store.seed(OTHER);
    const integ = integrationFor(h);

    await routineTurnContext.run(OWNER_CTX, async () => {
      await assert.rejects(
        () => integ.handleRoutineAction({ action: 'pause', id: foreign.id }),
        RoutineNotFoundError,
      );
    });
    assert.equal(h.store.rows.get(foreign.id)?.status, 'active');
  });

  it('refuses outside a channel turn, where there is no principal to scope to', async () => {
    const h = makeHarness();
    const own = h.store.seed(OWNER);
    const integ = integrationFor(h);

    const out = await integ.handleRoutineAction({
      action: 'delete',
      id: own.id,
    });

    assert.equal(out, ROUTINE_NO_CONTEXT_ERROR);
    assert.equal(h.store.rows.has(own.id), true);
  });

  it('still works for the turn owner', async () => {
    const h = makeHarness();
    const own = h.store.seed(OWNER);
    const integ = integrationFor(h);

    const out = await routineTurnContext.run(OWNER_CTX, () =>
      integ.handleRoutineAction({ action: 'pause', id: own.id }),
    );

    assert.match(out, /pausiert/);
    assert.equal(h.store.rows.get(own.id)?.status, 'paused');
  });
});
