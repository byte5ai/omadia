import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { CliIncompatibleError } from '@omadia/orchestrator';

import {
  classifyTurnError,
  getLastTurnOutcome,
  recordTurnFailure,
  recordTurnSuccess,
  resetLastTurnOutcome,
} from '../../src/platform/lastTurnOutcome.js';
import { createAdminLastTurnRouter } from '../../src/routes/adminLastTurn.js';

/**
 * OM-100b — the Systemstatus panel read all-green through a beta round in
 * which every turn died. These pin the signal that closes that gap: the last
 * turn's outcome, and the error CLASS behind a failure (a `cli_incompatible`
 * has a remedy no generic message conveys).
 */

describe('OM-100b — last-turn outcome', () => {
  afterEach(() => {
    resetLastTurnOutcome();
  });

  it('is undefined before any turn — an honest unknown, not a green light', () => {
    assert.equal(getLastTurnOutcome(), undefined);
  });

  it('records a successful turn', () => {
    recordTurnSuccess(1_700_000_000_000);
    assert.deepEqual(getLastTurnOutcome(), {
      status: 'ok',
      at: 1_700_000_000_000,
    });
  });

  it('classifies a CLI incompatibility with the versions the remedy needs', () => {
    const outcome = classifyTurnError(
      new CliIncompatibleError('nope', '--restricted', '2.1.100'),
    );
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.errorCode, 'cli_incompatible');
    assert.equal(outcome.cliVersion, '2.1.100');
    assert.equal(outcome.minCliVersion, '2.1.248');
  });

  it('classifies a spawn timeout apart from a generic failure', () => {
    assert.equal(
      classifyTurnError(new Error('CLI timed out after 600000ms without finishing'))
        .errorCode,
      'cli_timeout',
    );
    assert.equal(
      classifyTurnError(new Error('provider exploded')).errorCode,
      'orchestrator_failure',
    );
  });

  it('keeps only the first line of a multi-line error, capped', () => {
    const outcome = classifyTurnError(new Error(`boom\nstack line\nmore stack`));
    assert.equal(outcome.errorMessage, 'boom');
  });

  it('flips the stored outcome from ok to failed', () => {
    recordTurnSuccess();
    assert.equal(getLastTurnOutcome()?.status, 'ok');
    recordTurnFailure(new Error('provider exploded'));
    assert.equal(getLastTurnOutcome()?.status, 'failed');
    assert.equal(getLastTurnOutcome()?.errorCode, 'orchestrator_failure');
  });

  it('serves null over HTTP before any turn and the outcome afterwards', async () => {
    const router = createAdminLastTurnRouter();
    const first = await callRouter(router);
    assert.deepEqual(first, { lastTurn: null });

    recordTurnFailure(new CliIncompatibleError('nope', '--restricted', '2.1.100'));
    const second = (await callRouter(router)) as {
      lastTurn: { status: string; errorCode: string };
    };
    assert.equal(second.lastTurn.status, 'failed');
    assert.equal(second.lastTurn.errorCode, 'cli_incompatible');
  });
});

/**
 * Drive the router's single handler directly. Mounting an express app just to
 * read one JSON body would add a port and a lifecycle to a test that is about
 * the payload.
 */
type RouterLike = {
  stack: ReadonlyArray<{ route?: { stack: ReadonlyArray<{ handle: unknown }> } }>;
};

async function callRouter(router: unknown): Promise<unknown> {
  const layer = (router as RouterLike).stack[0];
  const handle = layer?.route?.stack[0]?.handle;
  assert.equal(typeof handle, 'function', 'router exposes a GET handler');
  return await new Promise((resolve) => {
    const res = {
      json: (body: unknown) => {
        resolve(body);
        return res;
      },
    };
    (handle as (req: unknown, res: unknown) => void)({}, res);
  });
}
