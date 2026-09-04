/**
 * #1016 — the turn-owner guard's decision table.
 *
 * The guard runs inside the async context restored around a loopback dispatch
 * and decides whether that context belongs to the turn being served. Each of
 * the four cases below is a deliberate choice, not a fallthrough, so each gets
 * its own assertion.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  TurnOwnerMismatchError,
  createRoutineTurnOwnerGuard,
} from '../src/plugins/routines/turnOwnerGuard.js';

/** Builds a guard whose "restored context" is whatever the test says it is. */
function guardOver(
  context: { readonly userId?: string } | undefined,
): { readonly run: (turnUserId?: string) => void; readonly logs: string[] } {
  const logs: string[] = [];
  const factory = createRoutineTurnOwnerGuard({
    currentContext: () => context,
    log: (message) => logs.push(message),
    newRef: () => 'ref00001',
  });
  return {
    run: (turnUserId?: string): void => {
      const guard = factory(turnUserId === undefined ? {} : { userId: turnUserId });
      assert.ok(guard, 'the factory must always produce a guard for a turn');
      guard();
    },
    logs,
  };
}

describe('routine turn-owner guard (#1016)', () => {
  it('passes when the restored context belongs to the same user as the turn', () => {
    const { run, logs } = guardOver({ userId: 'aad-oid-1' });
    run('aad-oid-1');
    assert.deepEqual(logs, [], 'a matching owner must not log a refusal');
  });

  it('refuses when the restored context belongs to a different user', () => {
    const { run, logs } = guardOver({ userId: 'aad-oid-PREVIOUS' });
    assert.throws(() => run('aad-oid-CURRENT'), TurnOwnerMismatchError);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', /aad-oid-PREVIOUS/);
    assert.match(logs[0] ?? '', /aad-oid-CURRENT/);
  });

  it('refuses when a context exists but the turn cannot vouch for an owner', () => {
    // The stale-chain shape: an `enterWith` value survived from an earlier
    // channel turn onto a turn that carries no user of its own.
    const { run } = guardOver({ userId: 'aad-oid-PREVIOUS' });
    assert.throws(() => run(undefined), TurnOwnerMismatchError);
  });

  it('passes when there is no context at all, leaving the tool to refuse', () => {
    // Pre-#993 behaviour, still correct: `manage_routine` answers "cannot
    // create routine outside a channel turn (no user context)". Throwing here
    // instead would turn an established, model-friendly refusal into a hard
    // error on every context-free HTTP turn.
    const { run, logs } = guardOver(undefined);
    run('aad-oid-1');
    run(undefined);
    assert.deepEqual(logs, []);
  });

  it('treats a blank id as absent rather than letting "" match ""', () => {
    assert.throws(() => guardOver({ userId: '   ' }).run('   '), TurnOwnerMismatchError);
  });

  it('keeps both principals out of the message the caller sees', () => {
    const { run } = guardOver({ userId: 'aad-oid-PREVIOUS' });
    try {
      run('aad-oid-CURRENT');
      assert.fail('expected a refusal');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The message travels back to the CLI and can reach the model; naming
      // the other user would leak one turn's principal into another's.
      assert.doesNotMatch(message, /aad-oid/);
      assert.match(message, /could not be verified/);
    }
  });

  it('carries one correlation ref into both the message and the log', () => {
    // Without this a production report ("the bot refused me") cannot be
    // matched to a log line, since neither side may name the principal.
    const { run, logs } = guardOver({ userId: 'aad-oid-PREVIOUS' });
    try {
      run('aad-oid-CURRENT');
      assert.fail('expected a refusal');
    } catch (err) {
      assert.ok(err instanceof TurnOwnerMismatchError);
      assert.equal(err.ref, 'ref00001');
      assert.match(err.message, /ref ref00001/);
    }
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', /ref=ref00001/);
  });

  it('mints a fresh ref per refusal so two reports cannot be conflated', () => {
    const seen: string[] = [];
    const factory = createRoutineTurnOwnerGuard({
      currentContext: () => ({ userId: 'aad-oid-PREVIOUS' }),
      log: () => {},
    });
    for (let i = 0; i < 2; i += 1) {
      try {
        factory({ userId: 'aad-oid-CURRENT' })?.();
      } catch (err) {
        if (err instanceof TurnOwnerMismatchError) seen.push(err.ref);
      }
    }
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
    assert.match(seen[0] ?? '', /^[0-9a-f]{8}$/);
  });

  it('reads the live routine context when no reader is injected', () => {
    // Guards the default wiring of the factory itself: with no `currentContext`
    // override it must consult `routineTurnContext`, which is empty here, so
    // the no-context branch applies rather than a crash.
    const guard = createRoutineTurnOwnerGuard()({ userId: 'aad-oid-1' });
    assert.ok(guard);
    guard();
  });
});
