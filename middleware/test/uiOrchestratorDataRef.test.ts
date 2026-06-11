/**
 * PR-9b-3 — DataRef HMAC sign + verify (omadia-ui-orchestrator/src/dataRef).
 *
 * `mintDataRef` signs a refreshable container reference; `verifyDataRefToken`
 * is the counterpart a future token-validated bulk-fetch endpoint gates on. We
 * pin the secret via env BEFORE the (dynamic) import so the expired-but-valid
 * signature branch is testable. node --test isolates each file in its own
 * process, so this env set never leaks into other suites.
 */

import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

const SECRET = 'unit-test-dataref-secret';
process.env['OMADIA_DATAREF_SECRET'] = SECRET;

const { mintDataRef, verifyDataRefToken } = await import(
  '../packages/omadia-ui-orchestrator/src/dataRef.js'
);

function signFor(canvasSessionId: string, containerId: string, expiryEpoch: number): string {
  return createHmac('sha256', Buffer.from(SECRET, 'utf8'))
    .update(`${canvasSessionId} ${containerId} ${expiryEpoch}`)
    .digest('hex');
}

describe('DataRef HMAC sign + verify (9b-3)', () => {
  it('round-trips a freshly minted token', () => {
    const ref = mintDataRef('cs1', 'tickets');
    assert.equal(
      verifyDataRefToken({
        canvasSessionId: 'cs1',
        containerId: 'tickets',
        signedToken: ref.signedToken,
        expiresAt: ref.expiresAt,
      }),
      true,
    );
  });

  it('rejects a tampered token, a wrong session, and a wrong container', () => {
    const ref = mintDataRef('cs1', 'tickets');
    const flipLast = ref.signedToken.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    assert.equal(
      verifyDataRefToken({
        canvasSessionId: 'cs1',
        containerId: 'tickets',
        signedToken: flipLast,
        expiresAt: ref.expiresAt,
      }),
      false,
      'tampered token',
    );
    assert.equal(
      verifyDataRefToken({
        canvasSessionId: 'cs2',
        containerId: 'tickets',
        signedToken: ref.signedToken,
        expiresAt: ref.expiresAt,
      }),
      false,
      'wrong session',
    );
    assert.equal(
      verifyDataRefToken({
        canvasSessionId: 'cs1',
        containerId: 'other',
        signedToken: ref.signedToken,
        expiresAt: ref.expiresAt,
      }),
      false,
      'wrong container',
    );
  });

  it('rejects a malformed or empty token without throwing', () => {
    const ref = mintDataRef('cs1', 'tickets');
    for (const bad of ['', 'xyz', 'not-hex!!', ref.signedToken.slice(0, 10)]) {
      assert.equal(
        verifyDataRefToken({
          canvasSessionId: 'cs1',
          containerId: 'tickets',
          signedToken: bad,
          expiresAt: ref.expiresAt,
        }),
        false,
        `malformed: ${JSON.stringify(bad)}`,
      );
    }
  });

  it('rejects an expired token even when correctly signed', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const expiryEpoch = Math.floor(new Date(past).getTime() / 1000);
    const token = signFor('cs1', 'tickets', expiryEpoch);
    assert.equal(
      verifyDataRefToken({
        canvasSessionId: 'cs1',
        containerId: 'tickets',
        signedToken: token,
        expiresAt: past,
      }),
      false,
    );
  });

  it('rejects an invalid expiresAt', () => {
    const ref = mintDataRef('cs1', 'tickets');
    assert.equal(
      verifyDataRefToken({
        canvasSessionId: 'cs1',
        containerId: 'tickets',
        signedToken: ref.signedToken,
        expiresAt: 'not-a-date',
      }),
      false,
    );
  });
});
