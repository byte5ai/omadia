/**
 * W4 — a failing turn teardown must not become the turn's exit reason.
 *
 * `turnContext.runGenerator` drives the inner generator's own `finally` blocks
 * (steering-bus teardown, privacy finalisation) inside the turn scope when a
 * consumer stops early. That drive — `await inner.return(undefined)` — sat bare
 * inside the wrapper's OWN `finally`, and an abrupt completion in a `finally`
 * REPLACES the pending completion of the whole generator. So a throwing privacy
 * finaliser overwrote the client abort that actually ended the turn: the caller
 * was handed a secondary teardown failure and the real reason — the one worth
 * debugging — was gone.
 *
 * The teardown failure is not swallowed either: it is reported through
 * `onTurnTeardownError`, which is what these tests assert against rather than
 * scraping console output.
 */
import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { onTurnTeardownError, turnContext } from '@omadia/orchestrator';

const TURN = { turnId: 'turn-teardown', turnDate: '2026-07-30' };

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** Capture what the wrapper reports instead of throwing. */
function captureTeardownErrors(): { seen: { turnId: string; err: unknown }[] } {
  const seen: { turnId: string; err: unknown }[] = [];
  restore = onTurnTeardownError((turnId, err) => seen.push({ turnId, err }));
  return { seen };
}

/**
 * An inner generator whose own `finally` throws — the privacy finaliser that
 * fails while the turn is already unwinding.
 */
function generatorWithFailingTeardown(
  observed: { turnIdAtTeardown?: string },
): () => AsyncGenerator<string> {
  return async function* inner(): AsyncGenerator<string> {
    try {
      yield 'chunk-1';
      yield 'chunk-2';
    } finally {
      observed.turnIdAtTeardown = turnContext.currentTurnId();
      throw new Error('privacy finalisation exploded');
    }
  };
}

describe('turnContext.runGenerator — teardown never replaces the exit reason (W4)', () => {
  it('MUTATION CHECK: a client abort survives a throwing finaliser', async () => {
    // The abort arrives as `gen.throw(...)` — the consumer telling the stream it
    // is over. Under the bug the teardown error replaced it and the caller was
    // told privacy finalisation failed, with no sign the client had disconnected.
    const { seen } = captureTeardownErrors();
    const observed: { turnIdAtTeardown?: string } = {};
    const gen = turnContext.runGenerator(TURN, generatorWithFailingTeardown(observed));

    assert.equal((await gen.next()).value, 'chunk-1');

    const abort = new Error('client aborted the stream');
    await assert.rejects(
      () => gen.throw(abort),
      (err: unknown) => {
        assert.equal(err, abort, 'the ORIGINAL abort must be what the caller sees');
        return true;
      },
    );

    // …and the teardown failure is surfaced, not lost.
    assert.equal(seen.length, 1, 'the teardown failure must be reported');
    assert.equal(seen[0]?.turnId, TURN.turnId);
    assert.match(String((seen[0]?.err as Error).message), /privacy finalisation exploded/);
  });

  it('MUTATION CHECK: a consumer breaking out is not turned into a failure', async () => {
    // The commonest shape: an SSE consumer stops reading (`break`), which calls
    // `gen.return()`. A throwing finaliser used to make that clean stop reject.
    const { seen } = captureTeardownErrors();
    const observed: { turnIdAtTeardown?: string } = {};
    const gen = turnContext.runGenerator(TURN, generatorWithFailingTeardown(observed));

    const received: string[] = [];
    for await (const chunk of gen) {
      received.push(chunk);
      break;
    }

    assert.deepEqual(received, ['chunk-1']);
    assert.equal(seen.length, 1, 'the teardown failure must still be reported');
    assert.match(String((seen[0]?.err as Error).message), /privacy finalisation exploded/);
  });

  it('teardown still runs INSIDE the turn scope — the reason this helper exists', async () => {
    // Regression guard on the original property: catching the teardown error must
    // not have moved the drive outside `storage.run`, or the finaliser would run
    // context-less and write to the wrong turn (or to none).
    captureTeardownErrors();
    const observed: { turnIdAtTeardown?: string } = {};
    const gen = turnContext.runGenerator(TURN, generatorWithFailingTeardown(observed));
    await gen.next();
    await gen.return(undefined);
    assert.equal(observed.turnIdAtTeardown, TURN.turnId);
  });

  it('a clean, fully-drained generator neither tears down nor reports anything', async () => {
    const { seen } = captureTeardownErrors();
    let finallyRuns = 0;
    const gen = turnContext.runGenerator(TURN, async function* (): AsyncGenerator<string> {
      try {
        yield 'only';
      } finally {
        finallyRuns += 1;
      }
    });

    const all: string[] = [];
    for await (const chunk of gen) all.push(chunk);

    assert.deepEqual(all, ['only']);
    assert.equal(finallyRuns, 1, 'the generator completed on its own');
    assert.deepEqual(seen, [], 'a clean turn reports no teardown failure');
  });

  it('a reporter that itself throws cannot become the exit reason either', async () => {
    restore = onTurnTeardownError(() => {
      throw new Error('the error reporter is down too');
    });
    const observed: { turnIdAtTeardown?: string } = {};
    const gen = turnContext.runGenerator(TURN, generatorWithFailingTeardown(observed));
    await gen.next();
    const abort = new Error('client aborted the stream');
    await assert.rejects(
      () => gen.throw(abort),
      (err: unknown) => err === abort,
    );
  });
});
