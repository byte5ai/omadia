/**
 * The notice a user reads when the answer verifier withheld an answer in
 * `enforce` mode. Text-only channels render nothing else, so the sentence has
 * to carry both halves on its own: that the answer was withheld, and why —
 * contradictions, claims it could not confirm, or a check that could not be
 * completed — plus what to do next. DE by default, EN on request, plain text.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { composeVerifierBlockedText } from '@omadia/channel-sdk';

const contradicted = (n: number) => ({ badge: 'failed' as const, contradictionCount: n });
const unconfirmed = { badge: 'partial' as const, contradictionCount: 0 };
const nothingConfirmed = { badge: 'unverified' as const, contradictionCount: 0 };
const notCompleted = { badge: 'unavailable' as const, contradictionCount: 0 };

describe('composeVerifierBlockedText', () => {
  it('names one or several contradictions, in German by default', () => {
    const one = composeVerifierBlockedText(undefined, contradicted(1));
    assert.match(one, /^Diese Antwort wurde zurückgehalten/);
    assert.match(one, /einen Widerspruch gefunden/);
    assert.match(one, /Stelle die Frage erneut/);
    assert.match(composeVerifierBlockedText('de', contradicted(2)), /2 Widersprüche gefunden/);
  });

  it('switches to English for an English locale', () => {
    assert.match(composeVerifierBlockedText('en', contradicted(1)), /^This answer was withheld: .*a contradiction\./);
    assert.match(composeVerifierBlockedText('en-GB', contradicted(3)), /3 contradictions/);
    assert.match(composeVerifierBlockedText('en', contradicted(1)), /Ask again/);
  });

  it('says the check could not confirm the claims when nothing was contradicted', () => {
    assert.match(composeVerifierBlockedText('de', unconfirmed), /nicht alle Angaben bestätigen/);
    assert.match(composeVerifierBlockedText('de', nothingConfirmed), /nicht alle Angaben bestätigen/);
    assert.match(composeVerifierBlockedText('en', unconfirmed), /could not confirm all of its statements/);
  });

  it('says the check could not be completed when the verifier failed', () => {
    assert.match(composeVerifierBlockedText('de', notCompleted), /nicht abgeschlossen werden/);
    assert.match(composeVerifierBlockedText('en', notCompleted), /could not be completed/);
  });

  it('reads a count that is not a positive integer as no contradiction', () => {
    for (const n of [0, -1, 1.5, Number.NaN]) {
      assert.match(
        composeVerifierBlockedText('de', { badge: 'failed', contradictionCount: n }),
        /nicht alle Angaben bestätigen/,
        String(n),
      );
    }
  });

  it('is one plain-text paragraph', () => {
    for (const locale of ['de', 'en']) {
      for (const summary of [contradicted(2), unconfirmed, notCompleted]) {
        const text = composeVerifierBlockedText(locale, summary);
        assert.doesNotMatch(text, /[<>*_`\n]/, text);
      }
    }
  });
});
