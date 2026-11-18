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
import { SecretsUnreadableError } from '../src/secretsBlob.ts';

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

/**
 * An unreadable secrets file needs its own dialog: the generic one offers
 * "Re-run setup", which cannot help (setup hits the same file) and was the
 * default button. Classified from the error's code, before it is flattened to
 * text, because message matching is exactly the coupling documented above.
 */
describe('classifyBootFailure — unreadable secrets file', () => {
  const unreadable = new SecretsUnreadableError({
    file: '/data/secrets.enc',
    stage: 'decrypt',
    reason: 'keychain denied',
    snapshotDir: '/data/snapshots',
    cause: new Error('keychain denied'),
  });

  it('classifies by the error code and carries what the dialog has to name', () => {
    const failure = classifyBootFailure(unreadable);
    assert.equal(failure.kind, 'secrets-unreadable');
    assert.ok(failure.kind === 'secrets-unreadable');
    assert.deepEqual(failure.secrets, {
      file: '/data/secrets.enc',
      stage: 'decrypt',
      reason: 'keychain denied',
      snapshotDir: '/data/snapshots',
    });
    assert.equal(failure.detail, unreadable.message, 'the full text still reaches the log');
  });

  it('does not classify on message text', () => {
    const lookalike = new Error(`${unreadable.message} (secrets_unreadable)`);
    assert.equal(classifyBootFailure(lookalike).kind, 'fatal');
  });

  it('does not trust a bare code without the fields the dialog needs', () => {
    const partial = Object.assign(new Error('boom'), { code: 'secrets_unreadable' });
    assert.equal(classifyBootFailure(partial).kind, 'fatal');
  });
});

/**
 * FU-161: quitting while the first page loads aborts `loadURL`, and that
 * rejection was presented as a boot failure: `[main] boot failed` in the log,
 * the tray in its error state, and possibly the failure dialog while the app
 * was exiting. Once the app is quitting nothing can be shown or acted on, so
 * every rejection is reported as `interrupted` and only logged.
 */
describe('classifyBootFailure — the app is quitting (FU-161)', () => {
  const aborted = new Error("ERR_ABORTED (-3) loading 'http://127.0.0.1:4567/'");

  it('reports a rejection while quitting as interrupted, with its detail for the log', () => {
    const failure = classifyBootFailure(aborted, { quitting: true });
    assert.equal(failure.kind, 'interrupted');
    assert.equal(failure.detail, aborted.message);
  });

  it('wins over every other kind: no dialog can be shown by an app that is exiting', () => {
    const unreadable = new SecretsUnreadableError({
      file: '/data/secrets.enc',
      stage: 'decrypt',
      reason: 'keychain denied',
      snapshotDir: null,
      cause: new Error('keychain denied'),
    });
    for (const err of [new Error('boot superseded'), new Error('kernel exited with code 1'), unreadable]) {
      assert.equal(classifyBootFailure(err, { quitting: true }).kind, 'interrupted', describeError(err));
    }
  });

  it('changes nothing while the app is not quitting', () => {
    for (const context of [undefined, {}, { quitting: false }]) {
      assert.equal(classifyBootFailure(aborted, context).kind, 'fatal', JSON.stringify(context));
      assert.equal(classifyBootFailure(new Error('boot superseded'), context).kind, 'superseded');
    }
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
   * Mutation-testing the classifier alone was not enough: changing the
   * SUPERVISOR'S message left everything green, while the effect would have been
   * the destructive Quit / Re-run-setup dialog returning during updates.
   *
   * IF THIS GOES RED: the set of literals `supervisor.ts` throws no longer
   * matches what this test expects. That is usually benign — a reworded message,
   * or a literal extracted into a `const`, which this regex cannot follow. Read
   * the assertion message, confirm `classifyBootFailure` still sorts the new
   * signals correctly, and re-point the test. Do not delete the assertion.
   */
  const source = fs.readFileSync(path.join(here, '..', 'src', 'supervisor.ts'), 'utf8');
  // Single, double or backtick quotes. A `const`-extracted message is invisible
  // to this and shows up as a missing literal, not as a wrong classification.
  const thrownLiterals = [
    ...source.matchAll(/throw new Error\(\s*(['"`])([^'"`]+)\1/g),
  ].map((match) => match[2] as string);

  it('finds literal rejections in the supervisor at all', () => {
    assert.ok(
      thrownLiterals.length > 0,
      'no `throw new Error(<literal>)` found in supervisor.ts. If it now throws a typed error, returns a sentinel, or builds messages from constants, re-point this tripwire and re-check classifyBootFailure.',
    );
  });

  it("classifies the supervisor's supersession rejection as a state, not a failure", () => {
    const superseded = thrownLiterals.filter(
      (message) => classifyBootFailure(new Error(message)).kind === 'superseded',
    );
    assert.equal(
      superseded.length >= 1,
      true,
      `none of supervisor.ts's thrown literals classifies as 'superseded': ${JSON.stringify(thrownLiterals)}. If the supersession signal was renamed, SUPERSEDED_MARKER needs updating — otherwise a discarded boot is presented as a failure with two destructive buttons.`,
    );
  });

  /**
   * The inverse regression, asserted PER LITERAL.
   *
   * A cardinality check ("at least one literal is fatal") is near-vacuous: it
   * passes while `SUPERSEDED_MARKER` is loose enough to swallow a real failure.
   * Loosening it to `/superseded|did not become healthy/` left the suite green
   * while making a hard boot timeout render as "omadia is applying an update,
   * please wait" — forever. Only a marker matching literally everything failed.
   *
   * So each genuinely-fatal signal is named and checked on its own.
   */
  const MUST_BE_FATAL: ReadonlyArray<{ readonly label: string; readonly match: RegExp }> = [
    { label: 'health-check timeout', match: /did not become healthy/i },
    { label: 'start refused while busy', match: /cannot start while/i },
    { label: 'restart refused while stopping', match: /cannot restart while stopping/i },
  ];

  for (const { label, match } of MUST_BE_FATAL) {
    it(`classifies the ${label} rejection as fatal`, () => {
      const literal = thrownLiterals.find((message) => match.test(message));
      assert.ok(
        literal,
        `supervisor.ts no longer throws a literal matching ${String(match)} (${label}). Found: ${JSON.stringify(thrownLiterals)}. Re-point this expectation.`,
      );
      assert.equal(
        classifyBootFailure(new Error(literal)).kind,
        'fatal',
        `"${literal}" classified as a state rather than a failure. SUPERSEDED_MARKER is too loose: this failure would render as "applying an update, please wait" and the user would never be told anything broke.`,
      );
    });
  }
});
