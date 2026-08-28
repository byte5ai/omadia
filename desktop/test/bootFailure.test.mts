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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyBootFailure, describeError } from '../src/bootFailure.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('classifyBootFailure', () => {
  it("treats the supervisor's superseded boot as a state, not a failure", () => {
    const failure = classifyBootFailure(new Error('boot superseded'));
    assert.equal(failure.kind, 'superseded');
    assert.equal(failure.detail, 'boot superseded');
  });

  it('survives a rename of the superseded marker', () => {
    // Matching loosely is the cheap insurance; the tripwire below is what makes
    // it actually hold.
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

describe('the supervisor marker is actually bridged to the classifier', () => {
  /**
   * A source-level tripwire, and the reason it is source-level: `supervisor.ts`
   * reaches Electron through `paths.ts`, so a Node test cannot import the real
   * `Supervisor` to provoke a real rejection.
   *
   * An earlier version of this suite only mutation-tested the classifier, so
   * changing the SUPERVISOR'S message left everything green — while the effect
   * would have been the destructive Quit / Re-run-setup dialog returning during
   * updates. PR #944 is reworking that exact path, so this reads the literals
   * the supervisor actually throws and runs them through the classifier.
   *
   * If it goes red: the supervisor's supersession signal changed. Re-point this
   * test, and check `classifyBootFailure` still recognises the new signal —
   * do not just delete the assertion.
   */
  const source = fs.readFileSync(path.join(here, '..', 'src', 'supervisor.ts'), 'utf8');
  const thrownLiterals = [...source.matchAll(/throw new Error\(\s*['\`]([^'\`]+)['\`]/g)].map(
    (match) => match[1] as string,
  );

  it('finds literal rejections in the supervisor at all', () => {
    assert.ok(
      thrownLiterals.length > 0,
      'no `throw new Error(<literal>)` found in supervisor.ts — if it now throws a typed error or returns a sentinel, re-point this tripwire and re-check classifyBootFailure',
    );
  });

  it("classifies the supervisor's own supersession rejection as a state", () => {
    const superseded = thrownLiterals.filter(
      (message) => classifyBootFailure(new Error(message)).kind === 'superseded',
    );
    assert.equal(
      superseded.length >= 1,
      true,
      `supervisor.ts throws ${JSON.stringify(thrownLiterals)}, none of which classifies as 'superseded'. The marker was renamed or removed, and the destructive boot-failure dialog is back during updates.`,
    );
  });

  it("does not classify the supervisor's real failures as a state", () => {
    // Guards the opposite regression: a marker so loose that a genuine failure
    // gets the harmless wait-dialog and the user is never told anything broke.
    const fatal = thrownLiterals.filter(
      (message) => classifyBootFailure(new Error(message)).kind === 'fatal',
    );
    assert.ok(
      fatal.length >= 1,
      `every literal in supervisor.ts classified as 'superseded': ${JSON.stringify(thrownLiterals)}`,
    );
  });
});
