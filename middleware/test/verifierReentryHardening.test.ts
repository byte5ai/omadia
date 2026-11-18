/**
 * Two guards around a verifier re-entry that the replay ledger relies on:
 *
 *  - The log line of a re-entry that threw names the run, the error's class
 *    and a closed code — never the error's message, which can quote a tool's
 *    or a provider's output.
 *  - A request's ledger is bound to its input object, and an input that
 *    already carries another ledger is refused: two requests sharing one
 *    input object would replay each other's tool results.
 *
 * All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ToolReplayAbortError,
  ToolReplayLedger,
} from '../packages/harness-orchestrator/src/toolReplayLedger.js';
import {
  REENTRY_FAILED,
  reentryFailureLine,
} from '../packages/harness-orchestrator/src/verifierReentry.js';
import { REQUEST, verifiedTurn } from './_helpers/replayTurnFixture.js';
import { approved } from './_helpers/verifierVerdictFixtures.js';

class ProviderUnavailableError extends Error {}

describe('the log line of a re-entry that threw', () => {
  it('names the run, the error class and a closed code — never the message', () => {
    const err = new ProviderUnavailableError('upstream said: customer max@kunde.example has no invoice');
    const line = reentryFailureLine('retry', 'run-7', err);
    assert.match(line, /retry FAIL run=run-7 class=ProviderUnavailableError code=/);
    assert.ok(line.endsWith(`code=${REENTRY_FAILED}`), line);
    assert.equal(line.includes('max@kunde.example'), false, 'the error message reached the log');
    assert.equal(line.includes('upstream said'), false);
  });

  it('a thrown non-error value logs its type, nothing of its content', () => {
    const line = reentryFailureLine('resample', 'run-8', 'secret-token-4711');
    assert.match(line, /resample FAIL run=run-8 class=string code=/);
    assert.equal(line.includes('secret-token-4711'), false);
  });

  it('an abandoned re-entry still says which call it needed', () => {
    const line = reentryFailureLine('retry', 'run-9', new ToolReplayAbortError('create_invoice'));
    assert.match(line, /retry abandoned run=run-9/);
    assert.ok(line.includes('create_invoice'), line);
  });
});

describe('binding a request ledger to an input', () => {
  it('refuses a second ledger on an input that carries one, and re-binds the same one', () => {
    const { orchestrator } = verifiedTurn({ responses: [], verdicts: [approved()] });
    const input = { ...REQUEST };
    const first = new ToolReplayLedger();
    const release = orchestrator.bindToolReplayLedger(input, first);

    assert.throws(() => orchestrator.bindToolReplayLedger(input, new ToolReplayLedger()), /already bound/);
    // A resample re-enters with the request's own input and ledger.
    assert.doesNotThrow(() => orchestrator.bindToolReplayLedger(input, first));

    release();
    assert.doesNotThrow(() => orchestrator.bindToolReplayLedger(input, new ToolReplayLedger()));
  });
});
