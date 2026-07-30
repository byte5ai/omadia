import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  InMemoryTaskStore,
  defineLongRunningTool,
  describeDeferredPrivacyPosture,
  longRunningToolNames,
  type LongRunningToolHandle,
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
