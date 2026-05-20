import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { SpecEventBus, type SpecBusEvent } from '../../src/plugins/builder/specEventBus.js';
import { UserChoiceCoordinator } from '../../src/plugins/builder/userChoiceCoordinator.js';

function setup() {
  const bus = new SpecEventBus();
  const events: SpecBusEvent[] = [];
  bus.subscribe('draft-1', (e) => events.push(e));
  const coord = new UserChoiceCoordinator({
    bus,
    timeoutMs: 100,
    generateId: () => 'fixed-choice',
  });
  return { bus, events, coord };
}

describe('UserChoiceCoordinator', () => {
  let coordinators: UserChoiceCoordinator[] = [];

  function track(c: UserChoiceCoordinator): UserChoiceCoordinator {
    coordinators.push(c);
    return c;
  }

  afterEach(() => {
    for (const c of coordinators) c.cancelAll();
    coordinators = [];
  });

  function setupTracked() {
    const ctx = setup();
    track(ctx.coord);
    return ctx;
  }

  it('emits user_choice_required on create', async () => {
    const { events, coord } = setupTracked();
    const { result } = coord.create({
      draftId: 'draft-1',
      question: 'Workaround or pause?',
      options: [
        { value: 'workaround', label: 'Workaround' },
        { value: 'pause', label: 'Pause' },
      ],
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'user_choice_required');
    // Resolve so the test does not leak a pending promise.
    coord.resolve({ draftId: 'draft-1', choiceId: 'fixed-choice', value: 'workaround' });
    await result;
  });

  it('resolves the pending promise on resolve()', async () => {
    const { coord } = setupTracked();
    const { result } = coord.create({
      draftId: 'draft-1',
      question: 'pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const ok = coord.resolve({ draftId: 'draft-1', choiceId: 'fixed-choice', value: 'b' });
    assert.equal(ok, true);
    const outcome = await result;
    assert.deepEqual(outcome, { ok: true, choiceId: 'fixed-choice', value: 'b' });
  });

  it('rejects unknown choiceIds', () => {
    const { coord } = setupTracked();
    coord.create({
      draftId: 'draft-1',
      question: 'pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const ok = coord.resolve({
      draftId: 'draft-1',
      choiceId: 'wrong-id',
      value: 'a',
    });
    assert.equal(ok, false);
  });

  it('rejects values that are not in the options list', () => {
    const { coord } = setupTracked();
    coord.create({
      draftId: 'draft-1',
      question: 'pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const ok = coord.resolve({
      draftId: 'draft-1',
      choiceId: 'fixed-choice',
      value: 'c',
    });
    assert.equal(ok, false);
  });

  it('cancels resolve as { ok: false, reason: cancelled }', async () => {
    const { coord } = setupTracked();
    const { result } = coord.create({
      draftId: 'draft-1',
      question: 'pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const ok = coord.cancel({ draftId: 'draft-1', choiceId: 'fixed-choice' });
    assert.equal(ok, true);
    const outcome = await result;
    assert.deepEqual(outcome, {
      ok: false,
      choiceId: 'fixed-choice',
      reason: 'cancelled',
    });
  });

  it('times out after timeoutMs', async () => {
    const { coord } = setupTracked();
    const { result } = coord.create({
      draftId: 'draft-1',
      question: 'pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const outcome = await result;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, 'timeout');
  });

  it('throws when options outside the [2, 4] band', () => {
    const { coord } = setupTracked();
    assert.throws(
      () =>
        coord.create({
          draftId: 'd',
          question: 'q',
          options: [{ value: 'only-one', label: 'Only' }],
        }),
      /2-4/,
    );
  });

  it('foreign draft cannot resolve a sibling draft choice', () => {
    const { coord } = setupTracked();
    coord.create({
      draftId: 'draft-1',
      question: 'pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const ok = coord.resolve({
      draftId: 'draft-other',
      choiceId: 'fixed-choice',
      value: 'a',
    });
    assert.equal(ok, false);
  });
});
