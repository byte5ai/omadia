/**
 * Sweep 2 / N13 — Privacy Shield masking edge cases.
 *
 *   #1528  a pseudonym the model rewrote (upper case, local part, the name
 *          read out of an e-mail) is restored or flagged, and a surrogate in
 *          replayed text is not masked again as a new real value;
 *   #1529  a deny-list term that occurs in the shield's own placeholder
 *          (`CUSTOM` in `PLATZHALTER-CUSTOM-1`, `TOM` in the same) is masked
 *          and sent instead of blocking the message;
 *   #1525  `custom_patterns` is a multi-line setup field.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import {
  countUnresolvedForms,
  findResidualRealValues,
  isReservedSurrogateShape,
  resolvePromptPseudonyms,
} from '@omadia/plugin-privacy-guard/dist/promptSurrogates.js';
import {
  CUSTOM_PATTERNS_CONFIG_KEY,
  CUSTOM_TERMS_CONFIG_KEY,
  MASK_USER_PROMPT_CONFIG_KEY,
} from '@omadia/plugin-privacy-guard/dist/service.js';
import {
  createBaselineDetector,
  createCustomTermsDetector,
  maskPrompt,
} from '@omadia/plugin-privacy-guard/dist/promptMask.js';
import { createPromptPseudonymMap } from '@omadia/plugin-privacy-guard/dist/v4/pseudonym.js';
import type { PseudonymMap } from '@omadia/plugin-privacy-guard/dist/v4/types.js';

import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function mapOf(pairs: ReadonlyArray<readonly [string, string]>): PseudonymMap {
  return {
    forward: new Map(pairs.map(([real, surrogate]) => [real, surrogate])),
    reverse: new Map(pairs.map(([real, surrogate]) => [surrogate, real])),
  };
}

function serviceWith(config: Record<string, string>) {
  return createPrivacyGuardService({ readConfig: (key: string) => config[key] });
}

describe('#1529 deny-list term inside the shield placeholder', () => {
  const blockedLive = [
    ['CUSTOM', 'Was bedeutet das Wort CUSTOM auf Englisch?'],
    ['CUSTOM;Tom', 'Wofür steht die Abkürzung TOM im Datenschutz?'],
    ['CUSTOM;Tom', 'CUSTOM und TOM und custom und tom'],
    ['PLATZHALTER', 'Was heißt PLATZHALTER?'],
  ] as const;

  for (const [terms, message] of blockedLive) {
    it(`masks and sends "${message}" with custom_terms=${terms}`, async () => {
      const svc = serviceWith({
        [MASK_USER_PROMPT_CONFIG_KEY]: 'on',
        [CUSTOM_TERMS_CONFIG_KEY]: terms,
      });
      const result = await svc.maskUserPrompt!({ sessionId: 's', turnId: 't', text: message });
      assert.equal(result.outcome, 'masked', JSON.stringify(result));
      if (result.outcome !== 'masked') return;
      assert.ok(result.spans.length > 0);
      assert.ok(result.spans.every((s) => s.type === 'custom'));
      // Only well-formed placeholders on the wire — none mangled by the sweep.
      const words = result.maskedText.match(/PLATZHALTER[\w-]*/g) ?? [];
      assert.ok(words.length > 0);
      for (const w of words) assert.match(w, /^PLATZHALTER-CUSTOM-\d+$/);
      // The user gets back exactly what they wrote.
      assert.equal(await svc.restorePromptPseudonyms!('t', result.maskedText), message);
    });
  }

  it('still blocks a real value that survives outside a placeholder', () => {
    const map = mapOf([['CUSTOM', 'PLATZHALTER-CUSTOM-1']]);
    assert.equal(findResidualRealValues('PLATZHALTER-CUSTOM-1 heißt …', map).length, 0);
    assert.equal(findResidualRealValues('PLATZHALTER-CUSTOM-1 und CUSTOM', map).length, 1);
  });

  it('redacts a tool error whose deny-list term is part of the [masked:…] marker', async () => {
    const svc = serviceWith({ [CUSTOM_TERMS_CONFIG_KEY]: 'custom;masked' });
    const result = await svc.redactToolErrorText!({
      turnId: 't',
      toolName: 'odoo_read',
      text: 'Error: custom field "masked" is missing',
    });
    assert.equal(result.outcome, 'redacted', JSON.stringify(result));
    if (result.outcome !== 'redacted') return;
    assert.equal(result.text, 'Error: [masked:custom] field "[masked:custom]" is missing');
  });
});

describe('#1528 tolerant pseudonym restore', () => {
  const map = mapOf([
    ['jonas.weber@example.com', 'lukas.becker@example.net'],
    ['Erika Muster', 'Mia Schulz'],
  ]);

  it('restores the exact surrogate as before', () => {
    assert.equal(
      resolvePromptPseudonyms('Schreib an lukas.becker@example.net.', map),
      'Schreib an jonas.weber@example.com.',
    );
  });

  it('restores an upper-cased surrogate in upper case', () => {
    assert.equal(
      resolvePromptPseudonyms('LUKAS.BECKER@EXAMPLE.NET', map),
      'JONAS.WEBER@EXAMPLE.COM',
    );
    assert.equal(resolvePromptPseudonyms('MIA SCHULZ', map), 'ERIKA MUSTER');
  });

  it('restores the local part and the name read out of an e-mail surrogate', () => {
    assert.equal(
      resolvePromptPseudonyms('Vor dem @ steht lukas.becker; die Adresse lautet lukas.becker@…', map),
      'Vor dem @ steht jonas.weber; die Adresse lautet jonas.weber@…',
    );
    assert.equal(
      resolvePromptPseudonyms('Die Adresse passt zu Lukas Becker.', map),
      'Die Adresse passt zu Jonas Weber.',
    );
  });

  it('leaves a variant glued into a longer word alone', () => {
    assert.equal(resolvePromptPseudonyms('LUKAS.BECKER@EXAMPLE.NETWORK', map), 'LUKAS.BECKER@EXAMPLE.NETWORK');
    assert.equal(resolvePromptPseudonyms('mia schulze', map), 'mia schulze');
  });

  it('counts a derived name it has no real name for as unresolved', () => {
    const opaque = mapOf([['jw1984@example.com', 'lukas.becker@example.net']]);
    const text = 'Die Adresse gehört Lukas Becker.';
    assert.equal(resolvePromptPseudonyms(text, opaque), text);
    assert.equal(countUnresolvedForms(text, opaque), 1);
    assert.equal(countUnresolvedForms('Die Adresse ist jw1984@example.com.', opaque), 0);
  });

  it('countUnresolvedSurrogates keeps same-value hits but can drop unreadable literals', async () => {
    const svc = serviceWith({ [MASK_USER_PROMPT_CONFIG_KEY]: 'on' });
    const masked = await svc.maskUserPrompt!({ sessionId: 's', turnId: 't', text: 'Geboren am 24.12.1987.' });
    assert.equal(masked.outcome, 'masked');
    if (masked.outcome !== 'masked') return;
    assert.ok(masked.maskedText.includes('01.01.1970'), masked.maskedText);
    const notice = { unreadableLiterals: false } as const;
    // The date surrogate restated in another spelling: a hit either way.
    const restated = 'Das war am 1. Januar 1970.';
    assert.equal(await svc.countUnresolvedSurrogates!('t', restated), 1);
    assert.equal(await svc.countUnresolvedSurrogates!('t', restated, notice), 1);
    // A date nobody can read: fail-closed hit for the verifier only.
    const unreadable = 'Das Datum 31.02.1970 gibt es nicht.';
    assert.equal(await svc.countUnresolvedSurrogates!('t', unreadable), 1);
    assert.equal(await svc.countUnresolvedSurrogates!('t', unreadable, notice), 0);
  });
});

describe('#1528 one surrogate per value, none re-masked', () => {
  it('gives a case variant of a known value the same surrogate in its case', () => {
    const first = createPromptPseudonymMap(
      [{ value: 'jonas.weber@example.com', type: 'email' }],
      'jonas.weber@example.com',
    );
    const surrogate = first.forward.get('jonas.weber@example.com')!;
    const next = createPromptPseudonymMap(
      [{ value: 'JONAS.WEBER@EXAMPLE.COM', type: 'email' }],
      'JONAS.WEBER@EXAMPLE.COM',
      first,
    );
    assert.equal(next.forward.get('JONAS.WEBER@EXAMPLE.COM'), surrogate.toUpperCase());
    assert.equal(next.reverse.get(surrogate.toUpperCase()), 'JONAS.WEBER@EXAMPLE.COM');
  });

  it('recognizes the reserved surrogate shapes, never a realistic name', () => {
    for (const shape of [
      'lukas.becker@example.net',
      'LUKAS.BECKER@EXAMPLE.NET',
      'PLATZHALTER-CUSTOM-1',
      'PLATZHALTER-NAME-12',
    ]) {
      assert.ok(isReservedSurrogateShape(shape), shape);
    }
    for (const real of [
      'Lukas Becker',
      'lukas.becker@example.com',
      'jonas.weber@example.net',
      'DE89370400440532013000',
      '+49 30 55590000',
      // Only what the shield mints: no free text in the type slot.
      'PLATZHALTER-Röntgen-1',
      'PLATZHALTER-JONAS-1',
      'mia.schulz12@example.net',
      'Musterstraße 7, 10037 Musterstadt',
      'DE00500105170100102000',
    ]) {
      assert.ok(!isReservedSurrogateShape(real), real);
    }
  });

  it('does not mask a surrogate a replayed answer kept as a new real value (live repro)', async () => {
    const svc = serviceWith({ [MASK_USER_PROMPT_CONFIG_KEY]: 'on' });
    // Turn 1: the user names a colleague; the model upper-cases the stand-in.
    const turn1 = await svc.maskUserPrompt!({
      sessionId: 's',
      turnId: 't1',
      text: 'Mein Kollege Jonas Weber, jonas.weber@example.com, schreib seine Adresse in GROSSBUCHSTABEN.',
    });
    assert.equal(turn1.outcome, 'masked');
    if (turn1.outcome !== 'masked') return;
    const surrogate = /[\w.]+@example\.net/.exec(turn1.maskedText)?.[0];
    assert.ok(surrogate);
    const answer1 = await svc.restorePromptPseudonyms!('t1', `Klar: ${surrogate.toUpperCase()}`);
    assert.equal(answer1, 'Klar: JONAS.WEBER@EXAMPLE.COM');
    await svc.finalizeTurn('t1');

    // Turn 2 (an older answer that still carried the stand-in is replayed).
    const replayed = await svc.maskReplayedAnswer!({
      sessionId: 's',
      turnId: 't2',
      text: `Klar: ${surrogate.toUpperCase()}`,
    });
    assert.equal(replayed.outcome, 'masked');
    if (replayed.outcome !== 'masked') return;
    assert.equal(replayed.maskedText, `Klar: ${surrogate.toUpperCase()}`);
    assert.equal(replayed.spans.length, 0);
    const question = await svc.maskUserPrompt!({ sessionId: 's', turnId: 't2', text: 'Was steht vor dem @?' });
    assert.equal(question.outcome, 'masked');
    const receipt = await svc.finalizeTurn('t2');
    assert.equal(receipt?.maskedPromptSpans?.length ?? 0, 0, 'no e-mail masked in turn 2');
  });

  it('a deny-list match inside an old placeholder is not masked again', async () => {
    const svc = serviceWith({
      [MASK_USER_PROMPT_CONFIG_KEY]: 'on',
      [CUSTOM_TERMS_CONFIG_KEY]: 'custom',
    });
    const result = await svc.maskReplayedAnswer!({
      sessionId: 's',
      turnId: 't',
      text: 'Gemeint war PLATZHALTER-CUSTOM-1, nicht custom.',
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    // Word-boundary extension takes the trailing '.' into the span.
    assert.match(result.maskedText, /^Gemeint war PLATZHALTER-CUSTOM-1, nicht PLATZHALTER-CUSTOM-\d+$/);
    assert.notEqual(
      /nicht (PLATZHALTER-CUSTOM-\d+)/.exec(result.maskedText)?.[1],
      'PLATZHALTER-CUSTOM-1',
      'the real term gets a placeholder the text does not already carry',
    );
  });
});

describe('#1525 custom_patterns is a multi-line setup field', () => {
  it('the manifest marks custom_patterns multiline', () => {
    const manifest = readFileSync(
      join(HERE, '..', 'packages', 'harness-plugin-privacy-guard', 'manifest.yaml'),
      'utf8',
    );
    const block = manifest.slice(manifest.indexOf(`- key: "${CUSTOM_PATTERNS_CONFIG_KEY}"`));
    const field = block.slice(0, block.indexOf('- key:', 5));
    assert.match(field, /\n\s+multiline: true\n/);
  });

  it('the store catalog carries the flag to the edit form', async () => {
    const entry = await loadManifestFromPath(
      join(HERE, '..', 'packages', 'harness-plugin-privacy-guard', 'manifest.yaml'),
    );
    const fields = entry?.plugin.setup_fields ?? [];
    const byKey = new Map(fields.map((f) => [f.key, f]));
    assert.equal(byKey.get(CUSTOM_PATTERNS_CONFIG_KEY)?.multiline, true);
    assert.equal(byKey.get(CUSTOM_TERMS_CONFIG_KEY)?.multiline, undefined);
  });

  it('two patterns, one per line, are both active', async () => {
    const svc = serviceWith({
      [MASK_USER_PROMPT_CONFIG_KEY]: 'on',
      [CUSTOM_PATTERNS_CONFIG_KEY]: 'PRJ-\\d{4}\nKD[0-9]{3};?',
    });
    const result = await svc.maskUserPrompt!({ sessionId: 's', turnId: 't', text: 'Siehe PRJ-1234 und KD123.' });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.spans.length, 2);
    assert.ok(!result.maskedText.includes('PRJ-1234') && !result.maskedText.includes('KD123'));
  });
});

describe('N13 security review regressions', () => {
  it('two unrelated values never get surrogates that differ only in case', () => {
    const map = createPromptPseudonymMap(
      [
        { value: 'Karl Muster', type: 'person' },
        { value: 'ANNA SCHMIDT', type: 'person' },
        { value: 'a@corp.de', type: 'email' },
        { value: 'B@OTHER.DE', type: 'email' },
      ],
      'Karl Muster, ANNA SCHMIDT, a@corp.de, B@OTHER.DE',
    );
    const lowered = [...map.reverse.keys()].map((k) => k.toLowerCase());
    assert.equal(new Set(lowered).size, lowered.length, JSON.stringify([...map.reverse]));
    for (const [real, surrogate] of map.forward) {
      assert.equal(resolvePromptPseudonyms(surrogate, map), real);
    }
  });

  it('a known value that overlaps a surrogate is still masked and still checked', async () => {
    const map = mapOf([
      ['Anna Schmidt', 'Lukas Becker'],
      ['Lukas Beckermann', 'Felix Wagner'],
    ]);
    assert.equal(findResidualRealValues('Ruf Lukas Beckermann an', map).length, 1);
    const masked = await maskPrompt('Ruf Lukas Beckermann an', [], map);
    assert.equal(masked.maskedText, 'Ruf Felix Wagner an');

    const custom = mapOf([['CUSTOM-1x', 'PLATZHALTER-CUSTOM-1']]);
    assert.equal(findResidualRealValues('PLATZHALTER-CUSTOM-1x', custom).length, 1);
  });

  it('digits in a lookalike reserved shape are masked by a digit pattern', async () => {
    const { detector } = createCustomTermsDetector({ terms: [], patterns: ['\\b\\d{6}\\b'] });
    assert.ok(detector);
    for (const text of ['PersNr 654321 / mia.wolf654321@example.net', 'mia.wolf654321@example.net']) {
      const masked = await maskPrompt(text, [createBaselineDetector(), detector]);
      assert.ok(!masked.maskedText.includes('654321'), masked.maskedText);
    }
  });

  it('a case-variant e-mail pair keeps its derived forms resolvable', () => {
    const map = createPromptPseudonymMap(
      [
        { value: 'jonas.weber@example.com', type: 'email' },
        { value: 'JONAS.WEBER@EXAMPLE.COM', type: 'email' },
      ],
      'jonas.weber@example.com JONAS.WEBER@EXAMPLE.COM',
    );
    assert.equal(resolvePromptPseudonyms('Lukas Becker', map), 'Jonas Weber');
    assert.equal(countUnresolvedForms('Lukas Becker', map), 0);
  });
});
