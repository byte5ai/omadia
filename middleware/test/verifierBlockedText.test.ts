/**
 * The notice a user reads when the answer verifier withheld an answer in
 * `enforce` mode. Text-only channels render nothing else, so the sentence has
 * to carry both halves on its own: that the answer was withheld, and why —
 * in words that are true for the cause and never stronger — plus what to do
 * next. DE by default, EN on request, plain text.
 *
 * The production incident (2026-10-07): three Teams answers withheld for
 * missing `[ref:…]` markers told the user "Die Faktenprüfung hat einen
 * Widerspruch gefunden" — no source had contradicted anything.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  composeVerifierBlockedText,
  composeVerifierDisclaimerText,
  type VerifierWithheldCause,
} from '@omadia/channel-sdk';

const contradicted = (n: number) => ({
  badge: 'failed' as const,
  contradictionCount: n,
  withheldCause: 'contradicted' as const,
});
const withCause = (withheldCause: VerifierWithheldCause) => ({
  badge: 'unverified' as const,
  contradictionCount: 0,
  withheldCause,
});

const CONTRADICTION_WORDS = /Widerspruch|widersprech|widerspricht|contradict/i;

describe('composeVerifierBlockedText', () => {
  it('names one or several contradictions, in German by default', () => {
    const one = composeVerifierBlockedText(undefined, contradicted(1));
    assert.match(one, /^Diese Antwort wurde zurückgehalten/);
    assert.match(one, /einen Widerspruch zu den Quelldaten gefunden/);
    assert.match(one, /Stelle die Frage erneut/);
    assert.match(composeVerifierBlockedText('de', contradicted(2)), /2 Widersprüche zu den Quelldaten/);
  });

  it('switches to English for an English locale', () => {
    assert.match(
      composeVerifierBlockedText('en', contradicted(1)),
      /^This answer was withheld: .*a contradiction with the source data\./,
    );
    assert.match(composeVerifierBlockedText('en-GB', contradicted(3)), /3 contradictions/);
    assert.match(composeVerifierBlockedText('en', contradicted(1)), /Ask again/);
  });

  it('never calls a missing citation a contradiction, and says what happened', () => {
    const de = composeVerifierBlockedText('de', withCause('citation_missing'));
    const en = composeVerifierBlockedText('en', withCause('citation_missing'));
    assert.doesNotMatch(de, CONTRADICTION_WORDS, de);
    assert.doesNotMatch(en, CONTRADICTION_WORDS, en);
    assert.match(de, /keine Quellen/);
    assert.match(en, /without naming the sources/);
  });

  it('says no data was retrieved when the turn made no call for it — never "no access"', () => {
    const de = composeVerifierBlockedText('de', withCause('tool_not_called'));
    assert.doesNotMatch(de, CONTRADICTION_WORDS, de);
    assert.doesNotMatch(de, /kein Zugriff|nicht erreichbar|technische/i, de);
    assert.match(de, /ohne dass die Daten in diesem Durchlauf abgerufen wurden/);
    assert.match(composeVerifierBlockedText('en', withCause('tool_not_called')), /without the data having been retrieved/);
  });

  it('names a technical fault as such, with a retry-later next step', () => {
    const de = composeVerifierBlockedText('de', withCause('check_failed'));
    assert.match(de, /technischen Störung nicht abgeschlossen/);
    assert.match(de, /wende dich an den Support/);
    assert.doesNotMatch(de, CONTRADICTION_WORDS, de);
    assert.match(composeVerifierBlockedText('en', withCause('check_failed')), /technical fault/);
  });

  it('says unbacked claims could not be backed, and an unchecked answer was not checked', () => {
    const unbacked = composeVerifierBlockedText('de', withCause('insufficient_evidence'));
    assert.match(unbacked, /nicht alle Angaben ließen sich mit den abgerufenen Daten belegen/i);
    assert.doesNotMatch(unbacked, CONTRADICTION_WORDS, unbacked);
    const unchecked = composeVerifierBlockedText('de', withCause('not_checked'));
    assert.match(unchecked, /nicht übergeben werden/);
    assert.doesNotMatch(unchecked, /technische|Widerspruch/i, unchecked);
  });

  it('falls back to the counts for a summary built without a cause', () => {
    assert.match(
      composeVerifierBlockedText('de', { badge: 'failed', contradictionCount: 1 }),
      /einen Widerspruch/,
    );
    assert.match(
      composeVerifierBlockedText('de', { badge: 'unavailable', contradictionCount: 0 }),
      /technischen Störung/,
    );
    assert.match(
      composeVerifierBlockedText('de', { badge: 'partial', contradictionCount: 0 }),
      /nicht alle Angaben/i,
    );
  });

  it('reads a count that is not a positive integer as no contradiction', () => {
    for (const n of [0, -1, 1.5, Number.NaN]) {
      const text = composeVerifierBlockedText('de', { badge: 'failed', contradictionCount: n });
      assert.doesNotMatch(text, CONTRADICTION_WORDS, String(n));
    }
  });

  it('is one plain-text paragraph for every cause', () => {
    const causes: VerifierWithheldCause[] = [
      'contradicted',
      'tool_not_called',
      'citation_missing',
      'insufficient_evidence',
      'check_failed',
      'not_checked',
    ];
    for (const locale of ['de', 'en']) {
      for (const cause of causes) {
        const text = composeVerifierBlockedText(locale, withCause(cause));
        assert.doesNotMatch(text, /[<>*_`\n]/, text);
      }
    }
  });
});

/**
 * The note on a RELEASED answer whose claims the check could not all confirm
 * (2026-10-08: unconfirmed is not wrong, so `enforce` releases it). It must
 * say no more than the counts back: "some statements" only when the check
 * confirmed at least one claim, "the statements" when it confirmed none.
 */
describe('composeVerifierDisclaimerText', () => {
  const counts = (claimCount: number, unverifiedCount: number, contradictionCount = 0) => ({
    claimCount,
    unverifiedCount,
    contradictionCount,
  });

  it('says "some" only when the check confirmed a claim', () => {
    assert.match(composeVerifierDisclaimerText('de', counts(3, 1)), /^Hinweis: Ein Teil der Angaben/);
    assert.match(composeVerifierDisclaimerText('de', counts(2, 2)), /^Hinweis: Die Angaben in dieser Antwort/);
    assert.match(composeVerifierDisclaimerText('de', counts(0, 0)), /^Hinweis: Die Angaben in dieser Antwort/);
  });

  it('never claims a confirmation the counts do not back', () => {
    // Malformed or inconsistent counts fall back to "none confirmed".
    for (const summary of [
      counts(1, 3),
      { claimCount: Number.NaN, unverifiedCount: 0, contradictionCount: 0 },
      { claimCount: -2, unverifiedCount: 0, contradictionCount: 0 },
      { claimCount: 2.5, unverifiedCount: 0, contradictionCount: 0 },
      { claimCount: 3, unverifiedCount: Number.NaN, contradictionCount: 0 },
      // A summary from a client that left the count out.
      { claimCount: 3, contradictionCount: 0, unverifiedCount: undefined as unknown as number },
      // Nothing unconfirmed: "some could not be confirmed" would be false.
      counts(3, 0),
      counts(2, 1, 1),
    ]) {
      assert.match(
        composeVerifierDisclaimerText('de', summary),
        /^Hinweis: Die Angaben/,
        JSON.stringify(summary),
      );
    }
  });

  it('speaks EN on request, DE by default, one plain-text paragraph', () => {
    assert.match(
      composeVerifierDisclaimerText('en', counts(3, 1)),
      /^Note: some statements in this answer could not be confirmed automatically\./,
    );
    assert.match(composeVerifierDisclaimerText('en-GB', counts(1, 1)), /^Note: the statements in this answer/);
    assert.match(composeVerifierDisclaimerText(undefined, counts(1, 1)), /^Hinweis:/);
    for (const text of [
      composeVerifierDisclaimerText('de', counts(3, 1)),
      composeVerifierDisclaimerText('de', counts(0, 0)),
      composeVerifierDisclaimerText('en', counts(3, 1)),
      composeVerifierDisclaimerText('en', counts(0, 0)),
    ]) {
      assert.doesNotMatch(text, /[<>*_`\n]/, text);
      assert.doesNotMatch(text, CONTRADICTION_WORDS, 'a disclaimer never speaks of a contradiction');
      assert.doesNotMatch(text, /zurückgehalten|withheld/i, 'the answer was not withheld');
    }
  });
});
