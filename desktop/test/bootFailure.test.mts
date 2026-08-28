/**
 * Unit tests for boot-failure classification (#931 / OM-56).
 *
 * The bug these pin: `Error: boot superseded` — a deliberate internal state
 * while an update is applied — was interpolated raw into an error dialog whose
 * two buttons could both do damage (*Quit* mid-update, *Re-run setup* during a
 * database snapshot). The only correct action, waiting, was not offered.
 *
 * The coupling to the supervisor's error MESSAGE is deliberate and documented in
 * `bootFailure.ts`. If that marker is ever dropped, the first case here goes red
 * — which is the point of testing the marker rather than the exact string.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { classifyBootFailure, describeError } from '../src/bootFailure.ts';

describe('classifyBootFailure', () => {
  it("treats the supervisor's superseded boot as a state, not a failure", () => {
    const failure = classifyBootFailure(new Error('boot superseded'));
    assert.equal(failure.kind, 'superseded');
    assert.equal(failure.detail, 'boot superseded');
  });

  it('survives a rename of the superseded marker', () => {
    // PR #944 reworks this lifecycle; matching loosely is the cheap insurance.
    for (const message of ['start superseded', 'boot was superseded by gen 3', 'SUPERSEDED']) {
      assert.equal(
        classifyBootFailure(new Error(message)).kind,
        'superseded',
        `"${message}" should still classify as superseded`,
      );
    }
  });

  it('treats a genuine failure as fatal', () => {
    const failure = classifyBootFailure(new Error('kernel exited with code 1'));
    assert.equal(failure.kind, 'fatal');
    assert.equal(failure.detail, 'kernel exited with code 1');
  });

  it('does not mistake an unrelated port error for a state', () => {
    assert.equal(classifyBootFailure(new Error('EADDRINUSE 5432')).kind, 'fatal');
  });
});

describe('describeError', () => {
  it('prefers the message of an Error', () => {
    assert.equal(describeError(new Error('nope')), 'nope');
  });

  it('falls back to the name when an Error carries no message', () => {
    assert.equal(describeError(new TypeError('')), 'TypeError');
  });

  it('passes a thrown string through unchanged', () => {
    assert.equal(describeError('plain failure'), 'plain failure');
  });

  it('serializes a thrown object so it still reaches the support detail', () => {
    assert.equal(describeError({ code: 'ENOENT' }), '{"code":"ENOENT"}');
  });

  it('survives a value that cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    // The exact text does not matter; not throwing on an error path does.
    assert.equal(typeof describeError(circular), 'string');
  });
});
