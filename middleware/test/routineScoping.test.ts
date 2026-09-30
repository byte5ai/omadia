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
import { RoutineActorRequiredError } from '../src/plugins/routines/routineCardActor.js';
import {
  getRefusedRoutineActionMetrics,
  resetRefusedRoutineActionMetrics,
} from '../src/plugins/routines/refusedRoutineActionMetrics.js';

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
  /**
   * The `owner` every scoped mutation (`setStatus`, `delete`) received, in
   * call order. `undefined` is the unscoped, cross-tenant statement — the
   * card-path tests assert it never shows up here.
   */
  readonly owners: Array<RoutineOwner | undefined> = [];
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
    this.owners.push(owner);
    const row = this.rows.get(id);
    if (!row || !matchesOwner(row, owner)) return null;
    const updated: Routine = { ...row, status, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async delete(id: string, owner?: RoutineOwner): Promise<boolean> {
    this.owners.push(owner);
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

  /**
   * Matches the standalone `id` column only. `/id = \$(\d+)/` would also
   * match the tail of `user_id = $4`, so on a statement scoped by owner but
   * NOT by row it reads user_id's placeholder and the assertion passes for
   * the wrong column — measured, it even matches
   * `WHERE tenant = $1 AND user_id = $2`, which is precisely the regression
   * this assertion exists to catch.
   */
  const ID_BOUND = /(?:^|[\s(])id = \$(\d+)/;

  /** The value the driver substitutes for the `$n` this pattern captures. */
  function boundTo(stmt: Recorded, pattern: RegExp): unknown {
    const match = pattern.exec(flat(stmt.text));
    assert.ok(match, `SQL does not match ${pattern}: ${flat(stmt.text)}`);
    return stmt.values[Number(match[1]) - 1];
  }

  /**
   * #1029 — asserting only tenant and user_id proves the owner predicate is
   * PRESENT, not that the statement is still row-scoped. Measured: rewriting
   * the scoped delete to `WHERE tenant = $1 AND user_id = $2` — which deletes
   * every routine that user owns — left the whole file green. Binding `id`
   * too is what makes the statement's target part of the contract.
   */
  it('setStatus binds id, tenant and user_id into its WHERE clause', async () => {
    const { store, stmts } = recordingStore();

    await store.setStatus('r1', 'paused', OWNER);

    const stmt = stmts[0];
    assert.ok(stmt);
    assert.equal(boundTo(stmt, ID_BOUND), 'r1');
    assert.equal(boundTo(stmt, /tenant = \$(\d+)/), OWNER.tenant);
    assert.equal(boundTo(stmt, /user_id = \$(\d+)/), OWNER.userId);
  });

  it('delete binds id, tenant and user_id into its WHERE clause', async () => {
    const { store, stmts } = recordingStore();

    await store.delete('r1', OWNER);

    const stmt = stmts[0];
    assert.ok(stmt);
    assert.equal(boundTo(stmt, ID_BOUND), 'r1');
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

/**
 * THE CARD PATH. The Teams adapter dispatches card clicks out-of-band
 * (`handleMessage` returns before `runOrchestratorTurn`, so
 * `captureRoutineTurn` never fires) and the card payload carries only the
 * routine id. So the principal is the channel's `actor` or nothing — and
 * nothing is a refusal. #1029 briefly let "nothing" run UNSCOPED, which meant
 * a missing principal widened rights to operator level; these tests pin the
 * opposite.
 *
 * Most tests here are deliberately NOT wrapped in `routineTurnContext.run`,
 * because production never is: the wrapper is what made the first #1029
 * suite pass while all four buttons would have failed in the field. The one
 * that IS wrapped proves a context found on this path is ignored.
 */
describe('#1025 smart-card actions — the principal comes from the channel, or the click is refused', () => {
  function integrationFor(h: Harness) {
    return createRoutinesIntegration({
      store: h.store as unknown as RoutineStore,
      runner: h.runner,
    } as unknown as RoutinesHandle);
  }

  const OWNER_ACTOR = { tenant: OWNER.tenant, userId: OWNER.userId };

  it('refuses when the card supplies no actor: the row is untouched and the refusal is counted', async () => {
    const h = makeHarness();
    const own = h.store.seed(OWNER);
    const integ = integrationFor(h);
    resetRefusedRoutineActionMetrics();
    // Honest precondition: `enter()` uses `enterWith`, which has no scope
    // exit, so a leaked value from another test would silently turn this
    // into the ALS case and prove nothing.
    assert.equal(routineTurnContext.current(), undefined);

    await assert.rejects(
      () => integ.handleRoutineAction({ action: 'pause', id: own.id }),
      RoutineActorRequiredError,
    );

    assert.equal(h.store.rows.get(own.id)?.status, 'active');
    // Refused, and visibly so: an operator can tell an outdated adapter is
    // still sending identity-less clicks.
    const metrics = getRefusedRoutineActionMetrics();
    assert.equal(metrics.calls, 1);
    assert.equal(metrics.byAction['pause'], 1);
  });

  it('a missing actor never widens to operator: a foreign routine survives all four actions', async () => {
    const h = makeHarness();
    const foreign = h.store.seed(OTHER);
    // Armed in the scheduler, so a cross-tenant pause or delete would show
    // up as an unregistration.
    await h.runner.resumeRoutine(foreign.id, { kind: 'operator' });
    const integ = integrationFor(h);
    resetRefusedRoutineActionMetrics();
    assert.equal(routineTurnContext.current(), undefined);

    for (const action of ['pause', 'resume', 'trigger_now', 'delete'] as const) {
      await assert.rejects(
        () => integ.handleRoutineAction({ action, id: foreign.id }),
        RoutineActorRequiredError,
        `${action} without an actor must be refused`,
      );
    }

    assert.equal(h.store.rows.get(foreign.id)?.status, 'active');
    // The decisive one: a manual run delivers into the routine's OWN
    // conversationRef, i.e. into the other tenant's conversation.
    assert.equal(h.runs.length, 0);
    assert.deepEqual(h.scheduler.unregistered, []);
    assert.equal(h.scheduler.registered.has(foreign.id), true);
    assert.equal(getRefusedRoutineActionMetrics().calls, 4);
  });

  it('a blank actor half is refused, not scoped to a partial principal', async () => {
    const h = makeHarness();
    const own = h.store.seed(OWNER);
    const integ = integrationFor(h);
    resetRefusedRoutineActionMetrics();

    // A blank tenant is not a tenant (the same rule `CoreApi` applies to
    // `turn.tenantId`), and a whitespace user id is not a user.
    for (const actor of [
      { tenant: '', userId: OWNER.userId },
      { tenant: OWNER.tenant, userId: '   ' },
    ]) {
      await assert.rejects(
        () => integ.handleRoutineAction({ action: 'pause', id: own.id, actor }),
        RoutineActorRequiredError,
      );
    }

    assert.equal(h.store.rows.get(own.id)?.status, 'active');
    assert.equal(getRefusedRoutineActionMetrics().calls, 2);
  });

  it('a malformed actor from an untyped caller is refused', async () => {
    // The contract types `actor` as two strings, but a channel plugin built
    // against an older contract — or plain JavaScript — can send anything.
    const h = makeHarness();
    const own = h.store.seed(OWNER);
    const untyped = integrationFor(h) as unknown as {
      handleRoutineAction(input: Record<string, unknown>): Promise<string>;
    };
    resetRefusedRoutineActionMetrics();

    const malformed: unknown[] = [
      null,
      OWNER.userId,
      {},
      { tenant: 42, userId: OWNER.userId },
      { tenant: OWNER.tenant, userId: [OWNER.userId] },
    ];
    for (const actor of malformed) {
      await assert.rejects(
        () => untyped.handleRoutineAction({ action: 'pause', id: own.id, actor }),
        RoutineActorRequiredError,
        `actor ${JSON.stringify(actor)} must be refused`,
      );
    }

    assert.equal(h.store.rows.get(own.id)?.status, 'active');
    assert.equal(getRefusedRoutineActionMetrics().calls, malformed.length);
  });

  it('a captured turn context does not substitute for the actor', async () => {
    const h = makeHarness();
    const own = h.store.seed(OWNER);
    const integ = integrationFor(h);
    resetRefusedRoutineActionMetrics();

    // Even the OWNER's own context, on the OWNER's own routine. A card click
    // is dispatched out-of-band, so a context found on this path can only be
    // one `enterWith` leaked forward from an earlier turn (#1016) — possibly
    // someone else's. It says nothing about who clicked.
    await routineTurnContext.run(OWNER_CTX, async () => {
      await assert.rejects(
        () => integ.handleRoutineAction({ action: 'pause', id: own.id }),
        RoutineActorRequiredError,
      );
    });

    assert.equal(h.store.rows.get(own.id)?.status, 'active');
    assert.equal(getRefusedRoutineActionMetrics().calls, 1);
  });

  it('scopes from an explicit actor, with no turn context in play', async () => {
    const h = makeHarness();
    const foreign = h.store.seed(OTHER);
    const integ = integrationFor(h);
    resetRefusedRoutineActionMetrics();
    assert.equal(routineTurnContext.current(), undefined);

    // OWNER clicks a card carrying ANOTHER tenant's routine id.
    await assert.rejects(
      () =>
        integ.handleRoutineAction({
          action: 'pause',
          id: foreign.id,
          actor: OWNER_ACTOR,
        }),
      RoutineNotFoundError,
    );

    assert.equal(h.store.rows.get(foreign.id)?.status, 'active');
    // A scoped miss is a not-found, not a refusal: the actor was usable.
    assert.equal(getRefusedRoutineActionMetrics().calls, 0);
  });

  it('lets an explicit actor act on their own routine', async () => {
    const h = makeHarness();
    const own = h.store.seed(OWNER);
    const integ = integrationFor(h);
    resetRefusedRoutineActionMetrics();

    const out = await integ.handleRoutineAction({
      action: 'delete',
      id: own.id,
      actor: OWNER_ACTOR,
    });

    assert.equal(out, 'Routine gelöscht.');
    assert.equal(h.store.rows.has(own.id), false);
    assert.equal(getRefusedRoutineActionMetrics().calls, 0);
  });

  it('the explicit actor is decisive even inside another user\'s captured turn', async () => {
    const h = makeHarness();
    const own = h.store.seed(OWNER);
    const foreign = h.store.seed(OTHER);
    const integ = integrationFor(h);
    const otherCtx: ManageRoutineContext = {
      ...OWNER_CTX,
      tenant: OTHER.tenant,
      userId: OTHER.userId,
    };

    await routineTurnContext.run(otherCtx, async () => {
      // OWNER's click acts on OWNER's routine…
      const out = await integ.handleRoutineAction({
        action: 'pause',
        id: own.id,
        actor: OWNER_ACTOR,
      });
      assert.match(out, /pausiert/);
      // …and not on the routine of whoever the (stale) context names.
      await assert.rejects(
        () =>
          integ.handleRoutineAction({
            action: 'pause',
            id: foreign.id,
            actor: OWNER_ACTOR,
          }),
        RoutineNotFoundError,
      );
    });

    assert.equal(h.store.rows.get(own.id)?.status, 'paused');
    assert.equal(h.store.rows.get(foreign.id)?.status, 'active');
  });

  it('the card path never reaches the store without an owner', async () => {
    const h = makeHarness();
    const own = h.store.seed(OWNER);
    const integ = integrationFor(h);

    await integ.handleRoutineAction({ action: 'pause', id: own.id, actor: OWNER_ACTOR });
    await integ.handleRoutineAction({ action: 'resume', id: own.id, actor: OWNER_ACTOR });
    await integ.handleRoutineAction({ action: 'delete', id: own.id, actor: OWNER_ACTOR });
    assert.deepEqual(h.store.owners, [OWNER, OWNER, OWNER]);

    const next = h.store.seed(OWNER);
    await assert.rejects(
      () => integ.handleRoutineAction({ action: 'delete', id: next.id }),
      RoutineActorRequiredError,
    );
    // Refused before the store is touched at all — not even with an owner,
    // and above all not with `undefined`, the unscoped statement.
    assert.equal(h.store.owners.length, 3);
    assert.equal(h.store.rows.has(next.id), true);
  });
});

describe('RoutineActorRequiredError — the refusal text is a user-facing contract', () => {
  it('carries the German sentence the Teams adapter renders verbatim', () => {
    const err = new RoutineActorRequiredError('trigger_now');

    assert.ok(err instanceof Error);
    assert.equal(err.name, 'RoutineActorRequiredError');
    assert.equal(err.action, 'trigger_now');
    // Rendered after `Konnte die Routine nicht <verb>: ` — one sentence, no
    // trailing newline, and it names what has to be updated.
    assert.equal(
      err.message,
      'Keine Benutzeridentität für diese Karten-Aktion übermittelt — der ' +
        'Kanal-Adapter muss Mandant und Benutzer des Klicks mitgeben ' +
        '(Teams-Plugin ab 0.26.1).',
    );
  });
});
