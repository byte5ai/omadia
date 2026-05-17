import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  createAllowlist,
  filterHitsByAllowlist,
} from '@omadia/plugin-privacy-guard/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Privacy-Engine Hardening Slice #1 — Common-Words-Allowlist.
 *
 * Validates the `data/privacy-common-words-de.json` artifact (shipped
 * alongside the existing topic-nouns list) and the loader's
 * behaviour: the file's terms get exempted from the detector pool the
 * same way topic-nouns do, removing the dominant FP class for casual
 * chat vocabulary like "Hey", "Hallo", "Danke".
 *
 * Test strategy: read the file directly, hand its terms to
 * `createAllowlist` as the `repoDefault` source (mirroring what the
 * plugin loader does at activate-time), and confirm the recognition
 * + filtering behaviour against fixtures that match the 2026-05-15
 * production-screenshot failure pattern.
 */

const COMMON_WORDS_FILE = path.resolve(
  __dirname,
  '../packages/harness-plugin-privacy-guard/data/privacy-common-words-de.json',
);

async function loadCommonWordsTerms(): Promise<readonly string[]> {
  const raw = await fs.readFile(COMMON_WORDS_FILE, 'utf8');
  const parsed = JSON.parse(raw) as { terms: string[] };
  return parsed.terms;
}

describe('privacy-common-words-de.json · artifact', () => {
  it('is a valid JSON file with a non-empty terms array', async () => {
    const terms = await loadCommonWordsTerms();
    assert.ok(Array.isArray(terms));
    assert.ok(terms.length >= 20, `expected ≥ 20 terms, got ${terms.length}`);
  });

  it('every term is a non-empty string (no whitespace-only entries)', async () => {
    const terms = await loadCommonWordsTerms();
    for (const t of terms) {
      assert.equal(typeof t, 'string');
      assert.ok(t.trim().length > 0, `term "${t}" is whitespace-only`);
    }
  });

  it('contains the core German greetings + affirmations the screenshot revealed', async () => {
    const terms = (await loadCommonWordsTerms()).map((t) => t.toLowerCase());
    const required = [
      'hey',
      'hallo',
      'hi',
      'servus',
      'tschüss',
      'danke',
      'genau',
      'guten morgen',
    ];
    for (const r of required) {
      assert.ok(terms.includes(r), `missing required term "${r}"`);
    }
  });

  it('is alphabetically sorted (eases PR review + dedup)', async () => {
    const terms = await loadCommonWordsTerms();
    const sorted = [...terms].sort((a, b) =>
      a.localeCompare(b, 'de', { sensitivity: 'base' }),
    );
    for (let i = 0; i < terms.length; i += 1) {
      assert.equal(
        terms[i],
        sorted[i],
        `terms[${String(i)}] = "${terms[i]}" but sorted = "${sorted[i]}"`,
      );
    }
  });
});

describe('common-words allowlist · scan + filter behaviour', () => {
  it('recognises a German greeting at the start of a sentence', async () => {
    const terms = await loadCommonWordsTerms();
    const allowlist = createAllowlist({ repoDefaultTerms: terms });
    const matches = allowlist.scan('Hey Bitchi, sei lieb');
    const matchedTexts = matches.map((m) =>
      'Hey Bitchi, sei lieb'.slice(m.span[0], m.span[1]).toLowerCase(),
    );
    assert.ok(matchedTexts.includes('hey'), 'expected "Hey" to be allowlisted');
  });

  it('recognises greetings case-insensitively', async () => {
    const terms = await loadCommonWordsTerms();
    const allowlist = createAllowlist({ repoDefaultTerms: terms });
    for (const variant of ['HALLO', 'Hallo', 'hallo', 'HaLLo']) {
      const matches = allowlist.scan(`${variant} Marcel`);
      assert.equal(
        matches.length,
        1,
        `failed to match "${variant}" case-insensitively`,
      );
    }
  });

  it('respects word boundaries (does not match inside larger words)', async () => {
    const terms = await loadCommonWordsTerms();
    const allowlist = createAllowlist({ repoDefaultTerms: terms });
    // "Heyhalter" is contrived but the property must hold for "Tagebau"
    // (contains "Tag" as a prefix). The allowlist must NOT exempt
    // "Tag" inside "Tagebau" — that would let an entity sneak through.
    const matches = allowlist.scan('Heute war Tagebau auf der Agenda');
    const matchedTexts = matches.map((m) =>
      'Heute war Tagebau auf der Agenda'.slice(m.span[0], m.span[1]),
    );
    assert.ok(
      !matchedTexts.includes('Tag'),
      'allowlist must not match "Tag" inside "Tagebau"',
    );
  });

  it('handles multi-word phrases (Guten Morgen)', async () => {
    const terms = await loadCommonWordsTerms();
    const allowlist = createAllowlist({ repoDefaultTerms: terms });
    const matches = allowlist.scan('Guten Morgen zusammen, kurze Frage');
    const matchedTexts = matches.map((m) =>
      'Guten Morgen zusammen, kurze Frage'.slice(m.span[0], m.span[1]),
    );
    assert.ok(matchedTexts.includes('Guten Morgen'));
  });

  it('filters out detector hits whose span overlaps an allowlisted greeting', async () => {
    const terms = await loadCommonWordsTerms();
    const allowlist = createAllowlist({ repoDefaultTerms: terms });
    const text = 'Hey Marcel, was steht heute an?';
    const allowlistMatches = allowlist.scan(text);
    // Simulate a detector that wrongly tagged "Hey" (span 0-3) AND
    // correctly tagged "Marcel" (span 4-10). The allowlist must drop
    // the "Hey" hit and keep "Marcel".
    const detectorHits = [
      { span: [0, 3] as const, type: 'PERSON' },
      { span: [4, 10] as const, type: 'PERSON' },
    ];
    const filtered = filterHitsByAllowlist(detectorHits, allowlistMatches);
    assert.equal(filtered.length, 1, 'one hit should survive');
    assert.equal(filtered[0]?.span[0], 4);
    assert.equal(filtered[0]?.span[1], 10);
  });

  it('attributes matches to the `repoDefault` source', async () => {
    const terms = await loadCommonWordsTerms();
    const allowlist = createAllowlist({ repoDefaultTerms: terms });
    const matches = allowlist.scan('Danke nochmal!');
    assert.ok(matches.length >= 1);
    assert.equal(matches[0]?.source, 'repoDefault');
  });

  it('topic-nouns + common-words can coexist on the same source without dedup issues', async () => {
    const commonTerms = await loadCommonWordsTerms();
    // Synthetic mini topic-nouns list to confirm the same source can
    // carry both categories (mirrors the loader merging both files).
    const topicTerms = ['Urlaub', 'Abteilung'];
    const allowlist = createAllowlist({
      repoDefaultTerms: [...topicTerms, ...commonTerms],
    });
    const matches = allowlist.scan('Hey, kurze Frage zum Urlaub in der Abteilung');
    const texts = matches.map((m) =>
      'Hey, kurze Frage zum Urlaub in der Abteilung'.slice(m.span[0], m.span[1]),
    );
    assert.ok(texts.includes('Hey'));
    assert.ok(texts.includes('Urlaub'));
    assert.ok(texts.includes('Abteilung'));
  });
});
