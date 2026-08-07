import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  InMemoryTaskStore,
  defineLongRunningTool,
  describeDeferredPrivacyPosture,
  longRunningToolNames,
  runTaskReaperOnce,
  runWithDispatchCaller,
  type LongRunningToolHandle,
  type TaskOutcomeLostRecord,
} from '@omadia/orchestrator';

/**
 * W2-2 — the non-blocking contract: a long-running tool returns a HANDLE in
 * milliseconds, never blocks the tool batch, and streams a card into the turn.
 */

/** A never-resolving executor, so "did it block?" is decidable rather than a
 *  timing guess: if `_start` awaited the work, the await below would hang. */
function pendingForever(): { promise: Promise<string>; started: () => boolean } {
  let began = false;
  return {
    promise: new Promise<string>(() => {
      began = true;
    }),
    started: () => began,
  };
}

function buildTool(
  execute: Parameters<typeof defineLongRunningTool>[0]['execute'],
  store = new InMemoryTaskStore(),
): { handle: LongRunningToolHandle; store: InMemoryTaskStore } {
  const handle = defineLongRunningTool({
    toolName: 'slow_thing',
    longRunning: true,
    kind: 'slow',
    cardLabel: 'Slow Thing',
    startDescription: 'Start the slow thing.',
    inputProperties: { question: { type: 'string' } },
    requiredInput: ['question'],
    store,
    execute,
    eventsUrlFor: (id) => `/api/tasks/${id}/events`,
    onRunnerError: () => undefined,
  });
  return { handle, store };
}

function reg(handle: LongRunningToolHandle, suffix: 'start' | 'status' | 'list') {
  const name = longRunningToolNames('slow_thing')[suffix];
  const found = handle.registrations.find((r) => r.name === name);
  assert.ok(found, `missing registration ${name}`);
  return found;
}

describe('tasks/defineLongRunningTool — names + registrations', () => {
  it('registers exactly the start/status/list triple', () => {
    const { handle } = buildTool(async () => 'x');
    assert.deepEqual(
      handle.registrations.map((r) => r.name),
      ['slow_thing_start', 'slow_thing_status', 'slow_thing_list'],
    );
  });

  it('refuses a base name that cannot fit the _status suffix in 64 chars', () => {
    assert.throws(() => longRunningToolNames('a'.repeat(58)), TypeError);
    assert.throws(() => longRunningToolNames('bad name!'), TypeError);
  });

  it("tells the model that _start does NOT return the answer", () => {
    const { handle } = buildTool(async () => 'x');
    const doc = reg(handle, 'start').promptDoc;
    assert.match(doc, /returns IMMEDIATELY/);
    assert.match(doc, /does NOT return the answer/);
    assert.match(doc, /Never wait in a loop/);
  });
});

describe('tasks/defineLongRunningTool — non-blocking', () => {
  it('returns a handle without waiting for the work', async () => {
    const pending = pendingForever();
    const { handle } = buildTool(async () => pending.promise);

    // If `_start` awaited `execute`, this await never resolves and the test
    // times out — which is exactly the regression this pins.
    const out = await reg(handle, 'start').handler({ question: 'q' });
    const parsed = JSON.parse(out) as Record<string, unknown>;

    assert.equal(parsed['status'], 'task_started');
    assert.equal(parsed['tool'], 'slow_thing_start');
    assert.equal(parsed['kind'], 'slow');
    assert.equal(parsed['phase'], 'queued');
    assert.equal(typeof parsed['taskId'], 'string');
    // No result is present: the handle is not the answer.
    assert.equal(parsed['result'], undefined);
  });

  it('does not block a parallel tool batch', async () => {
    // Models dispatch tool_use blocks in one batch; a blocking long tool stalls
    // every sibling in it. Two starts plus a fast sibling must all settle while
    // the underlying work is still pending.
    const pending = pendingForever();
    const { handle } = buildTool(async () => pending.promise);
    const fast = async (): Promise<string> => 'sibling-done';

    const results = await Promise.all([
      reg(handle, 'start').handler({ question: 'a' }),
      reg(handle, 'start').handler({ question: 'b' }),
      fast(),
    ]);

    assert.equal(results[2], 'sibling-done');
    const ids = results.slice(0, 2).map((r) => (JSON.parse(r) as { taskId: string }).taskId);
    assert.equal(new Set(ids).size, 2, 'each start gets its own task');
  });

  it('surfaces the result via _status once the work completes', async () => {
    const { handle } = buildTool(async (input) => {
      const q = (input as { question: string }).question;
      return `answer to ${q}`;
    });

    const started = JSON.parse(
      await reg(handle, 'start').handler({ question: 'life' }),
    ) as { taskId: string };
    await handle.drainForTest();

    const status = JSON.parse(
      await reg(handle, 'status').handler({ taskId: started.taskId }),
    ) as Record<string, unknown>;

    assert.equal(status['status'], 'completed');
    assert.equal(status['terminal'], true);
    assert.equal(status['result'], 'answer to life');
  });

  it('records a thrown executor as a terminal failure, not a lost task', async () => {
    const { handle } = buildTool(async () => {
      throw new Error('backend exploded');
    });
    const started = JSON.parse(
      await reg(handle, 'start').handler({ question: 'q' }),
    ) as { taskId: string };
    await handle.drainForTest();

    const status = JSON.parse(
      await reg(handle, 'status').handler({ taskId: started.taskId }),
    ) as Record<string, unknown>;
    assert.equal(status['status'], 'failed');
    assert.equal(status['error'], 'backend exploded');
    assert.equal(status['result'], undefined);
  });

  it('refuses bad input as an Error string instead of throwing', async () => {
    const { handle } = buildTool(async () => 'x');
    assert.match(await reg(handle, 'start').handler('nope'), /^Error: /);
    assert.match(await reg(handle, 'status').handler({}), /^Error: /);
    assert.match(
      await reg(handle, 'status').handler({ taskId: 'ghost' }),
      /^Error: task "ghost" was not found/,
    );
  });

  // The pre-existing "lists only its own kind" case below seeds someone else's
  // task under a DIFFERENT kind, so it cannot see the leak that matters: two
  // callers of the SAME tool. `_list` filtered on `kind` alone and `_status`
  // accepted any task id, so Bob could enumerate Alice's tasks — terminal ones
  // included, which carry `result` and `error` — and then poll each id for its
  // full output.
  it('does not list another caller tasks of the same kind', async () => {
    const store = new InMemoryTaskStore();
    const { handle } = buildTool(async () => 'x', store);

    await runWithDispatchCaller({ principal: 'alice', scopes: [], requestId: 'r1' }, async () => {
      await reg(handle, 'start').handler({ question: 'alice-secret' });
    });
    await handle.drainForTest();

    const bobSees = await runWithDispatchCaller(
      { principal: 'bob', scopes: [], requestId: 'r2' },
      async () => JSON.parse(await reg(handle, 'list').handler({})) as unknown[],
    );
    assert.deepEqual(bobSees, [], "Bob listed Alice's task");

    const aliceSees = await runWithDispatchCaller(
      { principal: 'alice', scopes: [], requestId: 'r3' },
      async () => JSON.parse(await reg(handle, 'list').handler({})) as unknown[],
    );
    // Guard rail: scoping must not have been achieved by listing nothing at all.
    assert.equal(aliceSees.length, 1, 'Alice can no longer see her own task');
  });

  it('does not let another caller poll a task by id', async () => {
    const store = new InMemoryTaskStore();
    const { handle } = buildTool(async () => 'alice-result', store);

    const started = await runWithDispatchCaller(
      { principal: 'alice', scopes: [], requestId: 'r1' },
      async () =>
        JSON.parse(await reg(handle, 'start').handler({ question: 'q' })) as {
          taskId: string;
        },
    );
    await handle.drainForTest();

    const bob = await runWithDispatchCaller(
      { principal: 'bob', scopes: [], requestId: 'r2' },
      async () => reg(handle, 'status').handler({ taskId: started.taskId }),
    );
    // Same wording as a genuinely unknown id: distinguishing them would make
    // this an existence oracle over other callers' task ids.
    assert.match(bob, /^Error: task ".*" was not found/, "Bob polled Alice's task");
    assert.doesNotMatch(bob, /alice-result/, "Bob received Alice's result");

    const alice = await runWithDispatchCaller(
      { principal: 'alice', scopes: [], requestId: 'r3' },
      async () => reg(handle, 'status').handler({ taskId: started.taskId }),
    );
    assert.match(alice, /alice-result/, 'Alice can no longer poll her own task');
  });

  // Nothing drains cards on the deferred sub-agent path — hydration keeps
  // `handle.registrations` and discards the handle — so an unbounded array grew
  // for the life of the process, one entry per `_start`. The task reaper clears
  // task ROWS and cannot touch this closure's array.
  it('bounds undrained pending cards instead of retaining every start', async () => {
    const { handle } = buildTool(async () => 'x');
    for (let i = 0; i < 250; i += 1) {
      await reg(handle, 'start').handler({ question: `q${String(i)}` });
    }
    await handle.drainForTest();
    const cards = handle.takePendingCards();
    assert.ok(
      cards.length <= 100,
      `undrained cards grew without bound: ${String(cards.length)} retained after 250 starts`,
    );
    // Oldest dropped, newest kept — the newest is what a consumer would want if
    // one ever attaches.
    assert.equal(cards.at(-1)?.taskId !== undefined, true);
  });

  it('lists only its own kind', async () => {
    const store = new InMemoryTaskStore();
    await store.create({ kind: 'someone-elses-kind', input: {} });
    const { handle } = buildTool(async () => 'x', store);
    await reg(handle, 'start').handler({ question: 'mine' });
    await handle.drainForTest();

    const listed = JSON.parse(await reg(handle, 'list').handler({})) as unknown[];
    assert.equal(listed.length, 1);
    assert.equal((listed[0] as { kind: string }).kind, 'slow');
  });
});

describe('tasks/defineLongRunningTool — card streaming', () => {
  it('queues one card per start and hands it to the turn exactly once', async () => {
    const { handle } = buildTool(async () => 'x');
    assert.equal(handle.hasPendingCards(), false);

    await reg(handle, 'start').handler({ question: 'a' });
    await reg(handle, 'start').handler({ question: 'b' });
    assert.equal(handle.hasPendingCards(), true);

    const cards = handle.takePendingCards();
    assert.equal(cards.length, 2, 'a turn may start more than one task');
    assert.equal(cards[0]?.toolName, 'slow_thing_start');
    assert.equal(cards[0]?.label, 'Slow Thing');
    assert.equal(cards[0]?.status, 'working');
    assert.match(String(cards[0]?.eventsUrl), /^\/api\/tasks\/.+\/events$/);

    // Drained, not duplicated: a second drain in the same turn must be empty or
    // the UI would render the card twice.
    assert.deepEqual(handle.takePendingCards(), []);
    assert.equal(handle.hasPendingCards(), false);
  });

  it('does not queue a card for a refused start', async () => {
    const { handle } = buildTool(async () => 'x');
    await reg(handle, 'start').handler('garbage');
    assert.deepEqual(handle.takePendingCards(), []);
  });
});

describe('tasks/deferred-result privacy (criterion 6)', () => {
  it('a card carries NO result and NO input — the shield boundary holds', async () => {
    // Load-bearing. Cards are rendered client-side from the tool result / stream
    // event and never pass through Orchestrator.dispatchTool, so anything
    // sensitive placed on a card escapes the Privacy Shield data plane entirely.
    const secret = 'IBAN DE89370400440532013000';
    const { handle } = buildTool(async () => secret);

    await reg(handle, 'start').handler({ question: `please handle ${secret}` });
    const cards = handle.takePendingCards();
    assert.equal(cards.length, 1);

    const card = cards[0];
    assert.ok(card);
    const serialized = JSON.stringify(card);
    assert.ok(
      !serialized.includes(secret),
      `card leaked sensitive content: ${serialized}`,
    );
    // Positively pin the allowed key set, so a later field addition has to come
    // back through this test rather than sneaking a payload onto the card.
    assert.deepEqual(Object.keys(card).sort(), [
      'eventsUrl',
      'kind',
      'label',
      'phase',
      'status',
      'taskId',
      'toolName',
    ]);
  });

  it('a card is not updated with the result after the task completes', async () => {
    const secret = 'sk-live-should-never-be-on-a-card';
    const { handle } = buildTool(async () => secret);
    await reg(handle, 'start').handler({ question: 'q' });
    const cards = handle.takePendingCards();
    await handle.drainForTest();
    assert.ok(!JSON.stringify(cards).includes(secret));
  });

  it('the result reaches the model ONLY through the _status tool result', async () => {
    // That is what makes poll-time interning correct: `_status` is an ordinary
    // tool call inside a live turn, so that turn's dispatchTool privacy pass
    // applies to its return value in full.
    const secret = 'deferred-secret-value';
    const { handle } = buildTool(async () => secret);
    const started = JSON.parse(
      await reg(handle, 'start').handler({ question: 'q' }),
    ) as { taskId: string };

    // Not on the start result.
    assert.ok(!JSON.stringify(started).includes(secret));
    await handle.drainForTest();

    const status = await reg(handle, 'status').handler({ taskId: started.taskId });
    assert.ok(status.includes(secret), 'the poll is the delivery channel');
  });

  it('states the posture explicitly so it cannot drift silently', () => {
    const posture = describeDeferredPrivacyPosture();
    assert.match(posture, /interned at POLL time/);
    assert.match(posture, /cards carry no result or input/);
    assert.match(posture, /v1 limitation/);
  });
});

/**
 * A store whose `create` ACKNOWLEDGEMENT is reordered relative to the row write.
 *
 * Faithful model of any store with real I/O: the row (and its `createdAt`) is
 * written when `create` is called, but the promise resolves after a variable
 * round trip — so the order in which callers learn their task exists is NOT the
 * order the rows were created in. `defineLongRunningTool` spawns a task's runner
 * when its `create` resolves, which is exactly how a runner ends up starting for
 * a task that is not the oldest unclaimed one.
 *
 * Everything else delegates to the real `InMemoryTaskStore`: the claim, lease
 * and terminal semantics under test are the production ones.
 */
class AckReorderingTaskStore extends InMemoryTaskStore {
  /** Extra microtask ticks before `create` resolves, keyed by input marker. */
  private readonly ackDelayTicks = new Map<string, number>();

  delayAckFor(marker: string, ticks: number): void {
    this.ackDelayTicks.set(marker, ticks);
  }

  override async create(
    input: Parameters<InMemoryTaskStore['create']>[0],
  ): ReturnType<InMemoryTaskStore['create']> {
    // Row written NOW — `createdAt` ordering follows call order…
    const descriptor = await super.create(input);
    const marker = (input.input as { question?: string } | undefined)?.question;
    const ticks = marker === undefined ? 0 : (this.ackDelayTicks.get(marker) ?? 0);
    // …but the caller learns about it later, so runner-start order can differ.
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
    return descriptor;
  }
}

describe('tasks/defineLongRunningTool — crossed claims (W4)', () => {
  it('MUTATION CHECK: two same-kind tasks whose runners start out of order BOTH complete', async () => {
    // The bug: `claimNextPending(lease, kind)` returns the OLDEST unclaimed task
    // of that kind, not the one this runner was spawned for. With task A created
    // first but B's runner starting first, B's runner claimed A, saw the id
    // mismatch and returned WITHOUT releasing the claim; A's runner then claimed
    // B and did the same. Both tasks sat `working` under live-but-dead leases
    // with no executor at all until the orphan reaper failed them 15 minutes
    // later — so a user who asked two questions got two answers that never came.
    const store = new AckReorderingTaskStore();
    // A is created first (older `createdAt`) but acknowledged last, so its
    // runner starts second and B's runner is the one that reaches the pool head.
    store.delayAckFor('question-A', 4);
    store.delayAckFor('question-B', 0);

    const seen: string[] = [];
    const { handle } = buildTool(async (input) => {
      const q = (input as { question: string }).question;
      seen.push(q);
      return `answer for ${q}`;
    }, store);

    const [startedA, startedB] = await Promise.all([
      reg(handle, 'start').handler({ question: 'question-A' }),
      reg(handle, 'start').handler({ question: 'question-B' }),
    ]);
    const idA = (JSON.parse(startedA) as { taskId: string }).taskId;
    const idB = (JSON.parse(startedB) as { taskId: string }).taskId;
    assert.notEqual(idA, idB);

    await handle.drainForTest();

    // Both executed, exactly once each.
    assert.deepEqual([...seen].sort(), ['question-A', 'question-B']);

    // Both reached a terminal state carrying THEIR OWN answer — the property
    // that fails when a claim is crossed: under the old code both rows stayed
    // `working` with no result at all.
    const statusA = JSON.parse(
      await reg(handle, 'status').handler({ taskId: idA }),
    ) as Record<string, unknown>;
    const statusB = JSON.parse(
      await reg(handle, 'status').handler({ taskId: idB }),
    ) as Record<string, unknown>;

    assert.equal(statusA['status'], 'completed', 'task A must not be stranded');
    assert.equal(statusB['status'], 'completed', 'task B must not be stranded');
    assert.equal(statusA['result'], 'answer for question-A');
    assert.equal(statusB['result'], 'answer for question-B');

    // And no row is left holding a lease.
    for (const id of [idA, idB]) {
      const row = await store.get(id);
      assert.ok(row);
      assert.equal(row.claimedBy, null, `task ${id} still holds a lease`);
    }
  });

  it('MUTATION CHECK: a claim this runner cannot hand back is finished, never abandoned', async () => {
    // Defence in depth for a store that CANNOT honour the claim hint — the seam
    // permits exactly that, e.g. a store whose claim is a bare pool pop with no
    // id predicate and no release primitive. The rule the runner must follow is
    // "whatever you claimed, you finish": walking away from a claim is what
    // strands a task, regardless of WHY the ids differ.
    const store = new InMemoryTaskStore();
    const hintIgnoring = Object.create(store) as InMemoryTaskStore;
    Object.defineProperty(hintIgnoring, 'claimNextPending', {
      value: (lease: string, kind?: string) =>
        InMemoryTaskStore.prototype.claimNextPending.call(store, lease, kind),
    });

    // A pre-existing unclaimed task of the same kind, older than anything the
    // tool creates — so the pool head is never the task the runner asks for.
    const decoy = await store.create({ kind: 'slow', input: { question: 'decoy' } });

    const { handle } = buildTool(async (input) => {
      const q = (input as { question: string }).question;
      return `answer for ${q}`;
    }, hintIgnoring);

    await reg(handle, 'start').handler({ question: 'mine' });
    await handle.drainForTest();

    // The runner was spawned for the new task and handed `decoy`. It must have
    // executed and finished the DECOY rather than dropping it: the decoy is the
    // row it holds the lease on.
    const decoyRow = await store.get(decoy.id);
    assert.ok(decoyRow);
    assert.equal(
      decoyRow.status,
      'completed',
      'the claimed task was abandoned under a live lease',
    );
    assert.equal(decoyRow.result, 'answer for decoy');
    assert.equal(decoyRow.claimedBy, null, 'the lease was never released');
  });
});

describe('tasks/defineLongRunningTool — outcome lost to a reaped lease (W4)', () => {
  /** Drive a runner that finishes AFTER the reaper already failed its task. */
  async function reapMidFlight(executorOutcome: 'succeed' | 'throw'): Promise<{
    lost: TaskOutcomeLostRecord[];
    runnerErrors: unknown[];
    taskId: string;
    store: InMemoryTaskStore;
  }> {
    let clock = 1_000_000;
    const store = new InMemoryTaskStore({ clock: () => clock });
    const lost: TaskOutcomeLostRecord[] = [];
    const runnerErrors: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const handle = defineLongRunningTool({
      toolName: 'slow_thing',
      longRunning: true,
      kind: 'slow',
      cardLabel: 'Slow Thing',
      startDescription: 'Start the slow thing.',
      inputProperties: { question: { type: 'string' } },
      store,
      execute: async () => {
        await gate;
        if (executorOutcome === 'throw') throw new Error('backend exploded');
        return 'THE REAL ANSWER';
      },
      onRunnerError: (err) => runnerErrors.push(err),
      onOutcomeLost: (record) => lost.push(record),
    });

    const started = JSON.parse(
      await reg(handle, 'start').handler({ question: 'q' }),
    ) as { taskId: string };
    // Let the runner claim and enter `execute`.
    await Promise.resolve();
    await Promise.resolve();

    // The reaper decides the worker is dead and writes its own terminal row.
    clock += 20 * 60_000;
    const swept = await runTaskReaperOnce(store, { staleAfterMs: 15 * 60_000 });
    assert.equal(swept.staleFailed, 1, 'the reaper must have force-failed the task');

    release();
    await handle.drainForTest();
    return { lost, runnerErrors, taskId: started.taskId, store };
  }

  it('MUTATION CHECK: a SUCCESSFUL result is surfaced, not swallowed as a runner error', async () => {
    // The bug: `finish(…, 'completed')` threw `TaskLeaseLostError`, the generic
    // `catch` then called `finish(…, 'failed')` on the now-terminal row, that
    // threw AGAIN and escaped to `onRunnerError`. So a task that genuinely
    // SUCCEEDED left no trace of its result anywhere, and the caller saw the
    // reaper's generic "task abandoned" as if nothing had ever run.
    const { lost, runnerErrors, taskId } = await reapMidFlight('succeed');

    assert.deepEqual(runnerErrors, [], 'lease loss is not a runner error');
    assert.equal(lost.length, 1, 'the lost outcome must be reported exactly once');
    const record = lost[0];
    assert.ok(record);
    assert.equal(record.taskId, taskId);
    assert.equal(record.status, 'completed');
    assert.equal(
      record.result,
      'THE REAL ANSWER',
      'the real result must be preserved, not replaced by a generic abandonment',
    );
    assert.equal(record.error, undefined);
  });

  it('MUTATION CHECK: a FAILED outcome hitting the same race is reported, never re-thrown', async () => {
    const { lost, runnerErrors } = await reapMidFlight('throw');
    assert.deepEqual(runnerErrors, []);
    assert.equal(lost.length, 1);
    assert.equal(lost[0]?.status, 'failed');
    assert.equal(lost[0]?.error, 'backend exploded');
  });

  it('the stored row still reflects the reaper — terminal immutability is not relaxed', async () => {
    // Stated rather than implied: the outcome is surfaced through the hook, NOT
    // by overwriting a terminal row. That guard is what stops a zombie worker
    // from overwriting an outcome a new owner recorded, so it stays.
    const { store, taskId } = await reapMidFlight('succeed');
    const row = await store.get(taskId);
    assert.ok(row);
    assert.equal(row.status, 'failed');
    assert.match(String(row.error), /task abandoned/);
    assert.equal(row.result, null);
  });
});
