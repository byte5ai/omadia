/**
 * Live finding on Fly (2026-11-23): a tool result the model read under the
 * Privacy Shield said "rendered server-side for the lukas becker". C1 had
 * tagged the role noun "User" as a person; the turn's map then held "User",
 * and the case-insensitive re-mask of tool results (#1544) rewrote every
 * "user" into the surrogate.
 *
 * Pins:
 *   - a C1 `person` span made only of role nouns and determiners is dropped
 *     ("User", "the user", "der Kunde"); one with a name in it is kept whole;
 *   - name propagation never spreads a role noun of a person span;
 *   - the re-mask replaces a case variant only as a whole word;
 *   - end to end: "for the user" in a tool result stays as written, a real
 *     name in the same result is still masked.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createC1HttpDetector } from '@omadia/plugin-privacy-guard/dist/c1Detector.js';
import { propagatePersonNames } from '@omadia/plugin-privacy-guard/dist/c1NamePropagation.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { remaskKnownValues } from '@omadia/plugin-privacy-guard/dist/promptSurrogates.js';
import { isRoleNounOnly } from '@omadia/plugin-privacy-guard/dist/roleNouns.js';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';

/** A sidecar that tags every listed phrase found in the request text as a
 *  person, at 0.99 — the score C1 gives role nouns live. */
function taggingFetch(phrases: readonly string[]): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const { text } = JSON.parse(String(init?.body ?? '{}')) as { text: string };
    const spans = phrases.flatMap((phrase) => {
      const out: Array<Record<string, unknown>> = [];
      for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) {
        out.push({ start: at, end: at + phrase.length, text: phrase, label: 'person', score: 0.99 });
      }
      return out;
    });
    return new Response(JSON.stringify({ ok: true, model_version: 'test', spans }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('role nouns are not person names', () => {
  it('isRoleNounOnly: role nouns and determiners only, any case, EN and DE', () => {
    for (const roleOnly of [
      'User', 'user', 'USER', 'the user', 'Users', 'customer', 'Admin', 'operator',
      'Benutzer', 'Benutzerin', 'Kunde', 'Kunden', 'der Kunde', 'Nutzerinnen', 'Mitarbeiter',
    ]) {
      assert.equal(isRoleNounOnly(roleOnly), true, roleOnly);
    }
    for (const named of ['Anna Schmidt', 'Kunde Müller', 'Admin Jonas', 'Herr Becker', 'the', '', 'Userbase']) {
      assert.equal(isRoleNounOnly(named), false, named);
    }
  });

  it('C1 drops a role-noun person span and keeps a real name', async () => {
    const text = 'User fragt: kann der Kunde Anna Schmidt anrufen? Kunde Müller wartet.';
    const detector = createC1HttpDetector({
      resolveUrl: () => 'http://sidecar',
      fetchFn: taggingFetch(['User', 'der Kunde', 'Anna Schmidt', 'Kunde Müller']),
    });
    const values = (await detector.detect(text)).map((s) => text.slice(s.start, s.end));
    assert.deepEqual(values, ['Anna Schmidt', 'Kunde Müller']);
  });

  it('name propagation does not spread the role noun of a person span', () => {
    const text = 'Kunde Müller ruft an. Der Kunde fragt nach Müller.';
    const spans = propagatePersonNames(text, [{ start: 0, end: 12, type: 'person', confidence: 0.9 }]);
    const values = spans.map((s) => text.slice(s.start, s.end));
    assert.deepEqual(values, ['Kunde Müller', 'Müller']);
  });

  it('re-mask: a case variant only as a whole word, the exact value anywhere', () => {
    const map = {
      forward: new Map([['Falkenstein', 'Lukas Becker']]),
      reverse: new Map([['Lukas Becker', 'Falkenstein']]),
    };
    assert.equal(remaskKnownValues('see falkenstein.', map), 'see lukas becker.');
    assert.equal(remaskKnownValues('/p/notes_falkenstein.md', map), '/p/notes_lukas becker.md');
    assert.equal(remaskKnownValues('projektFalkenstein', map), 'projektLukas Becker');
    assert.equal(remaskKnownValues('falkensteiner Hof', map), 'falkensteiner Hof');
  });

  it('end to end: "for the user" in a tool result stays, a real name is masked', async () => {
    const svc = createPrivacyGuardService({
      readConfig: () => 'on',
      c1Detector: createC1HttpDetector({
        resolveUrl: () => 'http://sidecar',
        fetchFn: taggingFetch(['User', 'Anna Schmidt']),
      }),
    });
    const masked = await svc.maskUserPrompt!({
      sessionId: 's',
      turnId: 't-role-noun',
      text: 'User fragt: zeig mir das Profil von Anna Schmidt',
    });
    assert.equal(masked.outcome, 'masked');
    if (masked.outcome !== 'masked') return;
    assert.ok(masked.maskedText.startsWith('User fragt'), 'the role noun stays on the wire');
    assert.equal(findIdentityLeaks(masked.maskedText, ['Anna Schmidt']).length, 0);

    const toolResult = 'Profile of anna schmidt, rendered server-side for the user.';
    const remasked = svc.remaskPromptValues!('t-role-noun', toolResult);
    assert.ok(remasked.endsWith('rendered server-side for the user.'), remasked);
    assert.ok(!remasked.toLowerCase().includes('anna schmidt'), 'the echoed name is masked');
  });
});
