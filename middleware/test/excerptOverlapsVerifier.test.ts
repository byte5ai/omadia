/**
 * The save-as-memory excerpt (a Haiku call) no longer holds the verifier
 * back. A streamed answer's `done` is what the verifier starts at; before,
 * the orchestrator awaited the excerpt before yielding it, which measured
 * live ~2–5 s of a plain chat turn. Under a verifier that may re-enter the
 * request, the excerpt now runs alongside the verifier and reaches the
 * `done` that goes out through the request's commit.
 *
 * Drives the REAL `Orchestrator` under the REAL `VerifierService` (stream,
 * `enforce`); the model, the pipeline and the session logger are stubs. The
 * excerpt extractor only answers once the verifier pipeline has been called,
 * so the old order (excerpt before `done`) would never see it running.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PalaiaExcerpt, PalaiaExcerptExtractor } from '@omadia/plugin-api';

import type {
  SessionLogEntry,
  SessionLogger,
} from '../packages/harness-orchestrator/src/sessionLogger.js';
import {
  REQUEST,
  doneOf,
  drain,
  text,
  verifiedTurn,
  type VerifiedTurn,
} from './_helpers/replayTurnFixture.js';
import { approved, blocked } from './_helpers/verifierVerdictFixtures.js';

const FIRST = 'Die Rechnung INV/2026/0042 über 1.250 EUR ist angelegt.';
const CORRECTED = 'Die Rechnung INV/2026/0042 über 1.200 EUR ist angelegt.';
/** How long the extractor waits for the verifier before giving up. */
const VERIFIER_WAIT_MS = 2000;

const excerptOf = (answer: string): PalaiaExcerpt => ({
  suggestedKind: 'insight',
  suggestedSummary: `summary of: ${answer}`,
  excerpts: [answer],
  source: 'llm',
});

function sessionLogger(): SessionLogger {
  const logged: SessionLogEntry[] = [];
  return {
    log(entry: SessionLogEntry) {
      logged.push(entry);
      return Promise.resolve({ turnExternalId: `turn:scope-ex:${String(logged.length)}` });
    },
  } as unknown as SessionLogger;
}

/**
 * An extractor that answers only once the verifier pipeline ran (or after
 * {@link VERIFIER_WAIT_MS}), and records whether it saw it running.
 */
function gatedExtractor(turn: () => VerifiedTurn | undefined) {
  const seen: Array<{ answer: string; verifierWasRunning: boolean }> = [];
  const extractor: PalaiaExcerptExtractor = {
    async extract(input) {
      const startedAt = Date.now();
      while ((turn()?.verifyInputs.length ?? 0) === 0 && Date.now() - startedAt < VERIFIER_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      seen.push({
        answer: input.cleanedAssistantAnswer,
        verifierWasRunning: (turn()?.verifyInputs.length ?? 0) > 0,
      });
      return excerptOf(input.cleanedAssistantAnswer);
    },
  };
  return { extractor, seen };
}

describe('the save-as-memory excerpt overlaps the verifier (stream, enforce)', () => {
  it('the verifier runs before the excerpt resolves, and the done that goes out carries it', async () => {
    // The extractor reads the turn lazily: it is built before the turn is.
    const ref: { t?: VerifiedTurn } = {};
    const { extractor, seen } = gatedExtractor(() => ref.t);
    const t = (ref.t = verifiedTurn({
      responses: [text(FIRST)],
      verdicts: [approved()],
      orchestrator: { sessionLogger: sessionLogger(), excerptExtractor: extractor },
    }));

    const done = doneOf(await drain(t.service.chatStream(REQUEST)));

    assert.equal(seen.length, 1, 'one excerpt for the one pass');
    assert.equal(seen[0]?.verifierWasRunning, true, 'the verifier did not wait for the excerpt');
    assert.deepEqual(
      (done as { palaiaExcerpt?: PalaiaExcerpt }).palaiaExcerpt,
      excerptOf(FIRST),
      'the excerpt still reaches the client’s done (save-as-memory prefill)',
    );
  });

  it('a delivered correction retry carries the excerpt of the answer it delivers', async () => {
    // The extractor reads the turn lazily: it is built before the turn is.
    const ref: { t?: VerifiedTurn } = {};
    const { extractor, seen } = gatedExtractor(() => ref.t);
    const t = (ref.t = verifiedTurn({
      responses: [text(FIRST), text(CORRECTED)],
      verdicts: [blocked(), approved()],
      orchestrator: { sessionLogger: sessionLogger(), excerptExtractor: extractor },
    }));

    const done = doneOf(await drain(t.service.chatStream(REQUEST)));

    // The discarded first pass's excerpt is awaited by nobody (its row is
    // never committed), so it may still be running here — only the
    // delivered pass's is asserted.
    assert.ok(
      seen.some((s) => s.answer === CORRECTED),
      'the delivered pass made its own excerpt',
    );
    assert.deepEqual(
      (done as { palaiaExcerpt?: PalaiaExcerpt }).palaiaExcerpt,
      excerptOf(CORRECTED),
      'the done carries the delivered pass’s excerpt — not the contradicted first answer’s',
    );
  });
});
