import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  PrivacyDetector,
  PrivacyDetectorHit,
  PrivacyDetectorOutcome,
} from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import {
  detectSelfAnonymizationLabels,
  extractPersonTokenOrder,
  restoreOrScrubRemainingTokens,
  restoreSelfAnonymization,
  restoreUnresolvedPersonTokens,
} from '@omadia/plugin-privacy-guard/dist/selfAnonymization.js';
import { createTokenizeMap } from '@omadia/plugin-privacy-guard/dist/tokenizeMap.js';

// Test fixture: a deterministic name detector that tags every
// occurrence of a fixed allowlist of names. The default regex
// detector only catches emails/IBANs/etc.; the end-to-end tests
// here need name-level tokenisation to populate the turn-map.
function nameDetector(names: readonly string[]): PrivacyDetector {
  return {
    id: 'test-names:1',
    scanTargets: {
      systemPrompt: false,
      userMessages: true,
      assistantMessages: true,
    },
    async detect(text: string): Promise<PrivacyDetectorOutcome> {
      const hits: PrivacyDetectorHit[] = [];
      for (const name of names) {
        let from = 0;
        while (true) {
          const idx = text.indexOf(name, from);
          if (idx < 0) break;
          hits.push({
            type: 'pii.name',
            value: name,
            span: [idx, idx + name.length],
            confidence: 0.95,
            detector: 'test-names:1',
          });
          from = idx + name.length;
        }
      }
      return { hits, status: 'ok' };
    },
  };
}

// ---------------------------------------------------------------------------
// Privacy-Shield v2 (Phase A, post-deploy 2026-05-14) — mechanical
// restoration of LLM self-anonymization patterns.
//
// The LLM tends to substitute generic labels like "Mitarbeiter 1/2/3"
// for `«PERSON_N»` tokens in tabular output, despite explicit directive
// instructions. This module is the deterministic safety net: it scans
// the assistant text for recognised label patterns and restores them
// to real names by positional alignment with the last tool-result's
// person-token sequence.
//
// Coverage:
//   - Pattern detection across the German + English keyword set
//   - Positional restoration against an explicit token-order array
//   - Conservative skip when label count exceeds token list
//   - Token-order extraction from a tokenised tool result
//   - End-to-end through the service: processToolResult captures the
//     order, restoreSelfAnonymizationLabels uses it
// ---------------------------------------------------------------------------

describe('selfAnonymization · detectSelfAnonymizationLabels (Phase A)', () => {
  it('finds every keyword variant left-to-right', () => {
    const text =
      'Tabelle: Mitarbeiter 1 abwesend, Mitarbeiterin 2 krank, Kollege 3 in Urlaub, ' +
      'Employee 4 in office, Person 5 remote, Anonym 6 unknown.';
    const hits = detectSelfAnonymizationLabels(text);
    const keywords = hits.map((h) => h.keyword);
    assert.deepEqual(keywords, [
      'mitarbeiter',
      'mitarbeiterin',
      'kollege',
      'employee',
      'person',
      'anonym',
    ]);
    assert.deepEqual(
      hits.map((h) => h.index),
      [1, 2, 3, 4, 5, 6],
    );
  });

  it('ignores lower-case nouns inside narrative prose', () => {
    // "mitarbeiter dieses jahres" is regular German prose — no number,
    // no upper-case keyword. Must NOT match.
    const text = 'Der mitarbeiter dieses jahres heißt … (kein Token).';
    assert.deepEqual(detectSelfAnonymizationLabels(text), []);
  });

  it('returns empty on empty input', () => {
    assert.deepEqual(detectSelfAnonymizationLabels(''), []);
  });

  it('handles multiple occurrences of the same label', () => {
    // The LLM may reference "Mitarbeiter 1" in body prose AND a table cell.
    const text = 'Mitarbeiter 1 ist heute krank. Siehe Tabelle: | Mitarbeiter 1 | krank |';
    const hits = detectSelfAnonymizationLabels(text);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.index, 1);
    assert.equal(hits[1]?.index, 1);
  });
});

describe('selfAnonymization · extractPersonTokenOrder (Phase A)', () => {
  it('returns de-duplicated in-order person tokens', () => {
    const text =
      'Result: «PERSON_3», «PERSON_5», «PERSON_3» again, «PERSON_7», «EMAIL_2» (no email here).';
    const order = extractPersonTokenOrder(text);
    assert.deepEqual([...order], ['«PERSON_3»', '«PERSON_5»', '«PERSON_7»']);
  });

  it('returns empty array when text has no person tokens', () => {
    assert.deepEqual([...extractPersonTokenOrder('Just text, «EMAIL_1» only.')], []);
  });
});

describe('selfAnonymization · restoreSelfAnonymization (Phase A)', () => {
  it('substitutes labels positionally from the token order', () => {
    const map = createTokenizeMap();
    const tokAnna = map.tokenFor('Anna Müller', 'pii.name');
    const tokMax = map.tokenFor('Max Beispiel', 'pii.name');
    const tokenOrder = [tokAnna, tokMax];
    const text = '| Mitarbeiter 1 | Backend |\n| Mitarbeiter 2 | Frontend |';
    const result = restoreSelfAnonymization(text, tokenOrder, map);
    assert.equal(result.detected, 2);
    assert.equal(result.restored, 2);
    assert.equal(result.ambiguous, 0);
    assert.ok(result.text.includes('Anna Müller'));
    assert.ok(result.text.includes('Max Beispiel'));
    assert.ok(!result.text.includes('Mitarbeiter 1'));
    assert.ok(!result.text.includes('Mitarbeiter 2'));
  });

  it('keeps the same restoration for repeated occurrences of one label', () => {
    const map = createTokenizeMap();
    const tokAnna = map.tokenFor('Anna Müller', 'pii.name');
    const text =
      'Mitarbeiter 1 ist heute krank. Siehe Tabelle: | Mitarbeiter 1 | krank |';
    const result = restoreSelfAnonymization(text, [tokAnna], map);
    // 2 textual occurrences, 1 distinct label.
    assert.equal(result.detected, 1);
    assert.equal(result.restored, 1);
    // Both spots get the same real name.
    const annaOccurrences = (result.text.match(/Anna Müller/g) ?? []).length;
    assert.equal(annaOccurrences, 2);
  });

  it('conservatively skips when label count exceeds token list', () => {
    const map = createTokenizeMap();
    const tokAnna = map.tokenFor('Anna Müller', 'pii.name');
    // 3 labels, only 1 token captured — partial restore would misalign.
    const text =
      '| Mitarbeiter 1 | A |\n| Mitarbeiter 2 | B |\n| Mitarbeiter 3 | C |';
    const result = restoreSelfAnonymization(text, [tokAnna], map);
    assert.equal(result.detected, 3);
    assert.equal(result.restored, 0);
    assert.equal(result.ambiguous, 3);
    assert.equal(result.maxIndexSeen, 3);
    // Text untouched — operator sees the gap rather than a wrong restore.
    assert.equal(result.text, text);
  });

  it('returns unchanged text + zero stats when no labels match', () => {
    const map = createTokenizeMap();
    const text = 'Die Wettervorhersage für heute: sonnig.';
    const result = restoreSelfAnonymization(text, [], map);
    assert.equal(result.detected, 0);
    assert.equal(result.restored, 0);
    assert.equal(result.text, text);
    assert.deepEqual([...result.patternsHit], []);
  });

  it('skips when positional token does not resolve in the map (defensive)', () => {
    const map = createTokenizeMap();
    // Token name is well-formed but never minted — map.resolve returns
    // undefined. Restorer must not crash and must report ambiguity.
    const result = restoreSelfAnonymization(
      'Mitarbeiter 1 is in trouble.',
      ['«PERSON_99»'],
      map,
    );
    assert.equal(result.detected, 1);
    assert.equal(result.restored, 0);
    assert.equal(result.ambiguous, 1);
    assert.equal(result.text, 'Mitarbeiter 1 is in trouble.');
  });

  it('surfaces every distinct keyword that fired', () => {
    const map = createTokenizeMap();
    const t1 = map.tokenFor('Anna', 'pii.name');
    const t2 = map.tokenFor('Max', 'pii.name');
    const text = 'Mitarbeiter 1 und Employee 2 sind heute aktiv.';
    const result = restoreSelfAnonymization(text, [t1, t2], map);
    assert.equal(result.detected, 2);
    assert.equal(result.restored, 2);
    assert.deepEqual([...result.patternsHit].sort(), ['employee', 'mitarbeiter']);
  });
});

describe('selfAnonymization · restoreUnresolvedPersonTokens (Phase A.1)', () => {
  it('gap-fills a single hallucinated token between two restored names', () => {
    // Live failure mode v149: LLM emitted three rows; two with verbatim
    // tokens that `processInbound` restored to "Laurent Goerres" and
    // "Phillip Kalusek", and one with `«PERSON_12»` which the map
    // could not resolve and thus survived to the final text. The
    // gap-filler sees one unresolved token, one missing real name,
    // and substitutes.
    const map = createTokenizeMap();
    const t1 = map.tokenFor('Laurent Goerres', 'pii.name');
    const tMiddle = map.tokenFor('Bossity Schmidt', 'pii.name');
    const t3 = map.tokenFor('Phillip Kalusek', 'pii.name');
    void tMiddle; // The "missing" name; not emitted by the LLM.
    const text =
      '| Laurent Goerres | External Service | 15. Mai 2026 |\n' +
      '| «PERSON_99» | External Service | 15. Mai 2026 |\n' +
      '| Phillip Kalusek | External Service | 25. Mai 2026 |';
    const result = restoreUnresolvedPersonTokens(text, [t1, tMiddle, t3], map);
    assert.equal(result.detected, 1);
    assert.equal(result.restored, 1);
    assert.equal(result.ambiguous, 0);
    assert.ok(result.text.includes('Bossity Schmidt'));
    assert.ok(!result.text.includes('«PERSON_99»'));
    assert.deepEqual([...result.patternsHit], ['unresolved-token']);
  });

  it('conservatively skips when unresolved count does not match missing names', () => {
    // LLM dropped 2 names but only emitted 1 unresolved-shaped token →
    // we cannot tell which missing name belongs in the slot. Skip
    // rather than guess wrong.
    const map = createTokenizeMap();
    const tA = map.tokenFor('Anna Müller', 'pii.name');
    const tB = map.tokenFor('Bossity Schmidt', 'pii.name');
    const tC = map.tokenFor('Phillip Kalusek', 'pii.name');
    void tA;
    void tB;
    void tC;
    // Two names missing from text (Bossity + Anna), one unresolved token.
    const text = 'Row1: Phillip Kalusek, Row2: «PERSON_99»';
    const result = restoreUnresolvedPersonTokens(text, [tA, tB, tC], map);
    assert.equal(result.detected, 1);
    assert.equal(result.restored, 0);
    assert.equal(result.ambiguous, 1);
    assert.equal(result.text, text);
  });

  it('no-ops when token order is empty', () => {
    const map = createTokenizeMap();
    const text = 'Some «PERSON_5» here';
    const result = restoreUnresolvedPersonTokens(text, [], map);
    assert.equal(result.detected, 0);
    assert.equal(result.restored, 0);
    assert.equal(result.text, text);
  });

  it('skips tokens that DO resolve in the map (those are real, restored later)', () => {
    // If a token is in the map, processInbound would restore it
    // separately; this pass should leave it alone so it can show as
    // a real name after restoration. Construct a scenario where one
    // token resolves and we have no unresolved gap → no substitution.
    const map = createTokenizeMap();
    const t1 = map.tokenFor('Anna Müller', 'pii.name');
    const text = 'Resolved: «' + 'PERSON_1»'; // build the token literally
    void t1;
    const result = restoreUnresolvedPersonTokens(text, [t1], map);
    // Real name "Anna Müller" is missing from the text (not yet
    // restored), but the only token in the text DOES resolve — so
    // there are 0 unresolved candidates.
    assert.equal(result.detected, 0);
    assert.equal(result.restored, 0);
    assert.equal(result.text, text);
  });

  it('gap-fills two consecutive unresolved tokens when two names are missing', () => {
    // Two missing names, two unresolved tokens → positional 1:1.
    const map = createTokenizeMap();
    const t1 = map.tokenFor('Anna Müller', 'pii.name');
    const t2 = map.tokenFor('Bossity Schmidt', 'pii.name');
    const t3 = map.tokenFor('Phillip Kalusek', 'pii.name');
    void t1;
    void t2;
    const text = '| Phillip Kalusek | A |\n| «PERSON_88» | B |\n| «PERSON_99» | C |';
    const result = restoreUnresolvedPersonTokens(text, [t1, t2, t3], map);
    assert.equal(result.detected, 2);
    assert.equal(result.restored, 2);
    assert.ok(result.text.includes('Anna Müller'));
    assert.ok(result.text.includes('Bossity Schmidt'));
  });
});

describe('selfAnonymization · restoreOrScrubRemainingTokens (Phase A.2 post-egress)', () => {
  it('replaces unresolved «TYPE_N» tokens with per-type German placeholders', () => {
    const map = createTokenizeMap();
    // No bindings minted: every token is unresolved → placeholder fallback.
    const text =
      'Hi «PERSON_99», deine «EMAIL_5» und Kontoauszug «IBAN_2» liegen bereit.';
    const result = restoreOrScrubRemainingTokens(text, [], map);
    assert.equal(result.restoredPositional, 0);
    assert.equal(result.scrubbedToPlaceholder, 3);
    assert.ok(result.text.includes('[Name]'));
    assert.ok(result.text.includes('[E-Mail]'));
    assert.ok(result.text.includes('[IBAN]'));
    // Post-condition: no token shapes remain.
    assert.ok(!/«[A-Z][A-Z_]*_\d+»/.test(result.text));
  });

  it('uses positional restoration when unresolved count matches missing names', () => {
    // Live failure mode: egress masked 3 spontaneous names with fresh
    // tokens that the user would otherwise see. With 3 names missing
    // from the tool result, we substitute positionally.
    const map = createTokenizeMap();
    const t1 = map.tokenFor('Anna Müller', 'pii.name');
    const t2 = map.tokenFor('Bossity Schmidt', 'pii.name');
    const t3 = map.tokenFor('Phillip Kalusek', 'pii.name');
    // Egress minted fresh tokens for hallucinated spontaneous PII —
    // their bindings exist but point to non-name values that we
    // don't want to reveal. Treat them as restoration candidates.
    map.tokenFor('SomeHallucinatedName1', 'pii.name'); // mints «PERSON_4»
    map.tokenFor('AnotherHallucination', 'pii.name'); // mints «PERSON_5»
    map.tokenFor('ThirdOne', 'pii.name'); // mints «PERSON_6»
    void t1;
    void t2;
    void t3;
    const text =
      'Zusammenfassung: «PERSON_4» und «PERSON_5» kommen morgen zurück, «PERSON_6» erst am 25. Mai.';
    const result = restoreOrScrubRemainingTokens(text, [t1, t2, t3], map);
    // All 3 names missing → 3 candidates → positional substitution.
    assert.equal(result.restoredPositional, 3);
    assert.equal(result.scrubbedToPlaceholder, 0);
    assert.ok(result.text.includes('Anna Müller'));
    assert.ok(result.text.includes('Bossity Schmidt'));
    assert.ok(result.text.includes('Phillip Kalusek'));
  });

  it('falls back to placeholder when positional count does not match', () => {
    // 3 egress tokens but only 1 missing name → cannot align safely
    // → placeholder for all three.
    const map = createTokenizeMap();
    const t1 = map.tokenFor('Anna Müller', 'pii.name');
    const t2 = map.tokenFor('Bossity Schmidt', 'pii.name');
    const t3 = map.tokenFor('Phillip Kalusek', 'pii.name');
    map.tokenFor('SpontaneousA', 'pii.name'); // «PERSON_4»
    map.tokenFor('SpontaneousB', 'pii.name'); // «PERSON_5»
    map.tokenFor('SpontaneousC', 'pii.name'); // «PERSON_6»
    void t1;
    void t2;
    // Only Phillip is missing from text — 1 missing, 3 unresolved.
    const text =
      'Anna Müller and Bossity Schmidt are in the table. Plus «PERSON_4», «PERSON_5», «PERSON_6».';
    const result = restoreOrScrubRemainingTokens(text, [t1, t2, t3], map);
    assert.equal(result.restoredPositional, 0);
    assert.equal(result.scrubbedToPlaceholder, 3);
    assert.ok(!/«[A-Z][A-Z_]*_\d+»/.test(result.text));
    // Both real names that were already present stay present.
    assert.ok(result.text.includes('Anna Müller'));
    assert.ok(result.text.includes('Bossity Schmidt'));
  });

  it('returns unchanged text when no tokens present', () => {
    const map = createTokenizeMap();
    const text = 'Just a plain sentence with no tokens at all.';
    const result = restoreOrScrubRemainingTokens(text, [], map);
    assert.equal(result.restoredPositional, 0);
    assert.equal(result.scrubbedToPlaceholder, 0);
    assert.equal(result.text, text);
  });

  it('replaces token-shape-cycle bindings (sub-agent hallucinations) with placeholder', () => {
    // Pathological case: a token whose resolved value IS another
    // token shape. Phase A.2 must NOT reveal the inner token shape.
    const map = createTokenizeMap();
    map.tokenFor('«PERSON_9»', 'pii.name'); // mints «PERSON_1», value=«PERSON_9»
    const text = 'Hallucinated: «PERSON_1»';
    const result = restoreOrScrubRemainingTokens(text, [], map);
    assert.equal(result.restoredPositional, 0);
    assert.equal(result.scrubbedToPlaceholder, 1);
    assert.ok(!result.text.includes('«PERSON_'));
    assert.ok(result.text.includes('[Name]'));
  });
});

describe('PrivacyGuardService · restoreSelfAnonymizationLabels (Phase A end-to-end)', () => {
  it('captures the tool-result order and restores labels in the next call', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [nameDetector(['Anna Müller', 'Max Beispiel'])],
    });
    // 1) Seed the turn-map via processOutbound so the name detector
    //    mints tokens for the names that appear in the tool result.
    await service.processOutbound({
      sessionId: 's',
      turnId: 't',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'List my team: Anna Müller, Max Beispiel.' }],
    });
    // 2) Tool result references the same names. processToolResult
    //    tokenises them (idempotent — same names → same tokens) AND
    //    captures the «PERSON_N» order onto the accumulator.
    const toolText = 'Result rows: Anna Müller (Backend), Max Beispiel (Frontend).';
    const tool = await service.processToolResult({
      sessionId: 's',
      turnId: 't',
      toolName: 'hr_query',
      text: toolText,
    });
    assert.ok(tool.transformed, 'tool result should be tokenised');
    // 3) Simulate the LLM emitting self-anonymized labels.
    const llmOutput = '| Mitarbeiter 1 | Backend |\n| Mitarbeiter 2 | Frontend |';
    const restored = await service.restoreSelfAnonymizationLabels({
      sessionId: 's',
      turnId: 't',
      text: llmOutput,
    });
    assert.equal(restored.detected, 2);
    assert.equal(restored.restored, 2);
    assert.equal(restored.ambiguous, 0);
    assert.ok(restored.text.includes('Anna Müller'));
    assert.ok(restored.text.includes('Max Beispiel'));
    assert.equal(restored.tokenOrderLength, 2);
  });

  it('folds the summary into the receipt at finalizeTurn', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [nameDetector(['Anna Müller'])],
    });
    await service.processOutbound({
      sessionId: 's2',
      turnId: 't2',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'Anna Müller is on leave.' }],
    });
    await service.processToolResult({
      sessionId: 's2',
      turnId: 't2',
      toolName: 'hr_query',
      text: 'Row: Anna Müller (Backend).',
    });
    await service.restoreSelfAnonymizationLabels({
      sessionId: 's2',
      turnId: 't2',
      text: 'Mitarbeiter 1 is on leave.',
    });
    const receipt = await service.finalizeTurn('t2');
    if (!receipt) throw new Error('expected a receipt');
    assert.ok(receipt.selfAnonymization, 'expected receipt.selfAnonymization to be present');
    assert.equal(receipt.selfAnonymization.detected, 1);
    assert.equal(receipt.selfAnonymization.restored, 1);
    assert.equal(receipt.selfAnonymization.tokenOrderLength, 1);
    assert.deepEqual([...receipt.selfAnonymization.patternsHit], ['mitarbeiter']);
  });

  it('zero-match invocation still emits a summary block', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 's3',
      turnId: 't3',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'no pii' }],
    });
    const result = await service.restoreSelfAnonymizationLabels({
      sessionId: 's3',
      turnId: 't3',
      text: 'Just a plain answer without labels.',
    });
    assert.equal(result.detected, 0);
    assert.equal(result.restored, 0);
    const receipt = await service.finalizeTurn('t3');
    if (!receipt) throw new Error('expected a receipt');
    assert.ok(receipt.selfAnonymization);
    assert.equal(receipt.selfAnonymization.detected, 0);
    assert.equal(receipt.selfAnonymization.restored, 0);
  });
});
