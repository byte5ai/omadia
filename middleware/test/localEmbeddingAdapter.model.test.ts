import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  LOCAL_EMBEDDING_DIMENSIONS,
  RECOMMENDED_DEDUP_THRESHOLD,
  createLocalEmbeddingClient,
  missingModelFiles,
} from '../packages/embedding-adapter-local/src/localEmbeddingClient.js';

/**
 * The one test that runs the REAL model (OM-84 / byte5ai/omadia#1003).
 *
 * Opt-in, because the weights are ~144 MB and deliberately not in the repo or
 * the installers. Point it at a fetched model directory:
 *
 *   npm run fetch-model --workspace @omadia/embedding-adapter-local
 *   OMADIA_LOCAL_EMBEDDING_MODEL_DIR=var/embedding-models npm run test
 *
 * Without the variable it SKIPS rather than passing vacuously — a silent pass
 * here would be worse than no test, since the sibling suite already covers
 * everything that does not need the model.
 *
 * The thresholds below are not decoration. They are the measurement the whole
 * design rests on: this model's cosine scale is not the knowledge graph's 0.90
 * default, so if a future model bump moves the scale, dedup would quietly stop
 * firing — the exact failure #1003 was about. This test fails first instead.
 */

const modelDir = process.env['OMADIA_LOCAL_EMBEDDING_MODEL_DIR'];
const missing = modelDir === undefined ? ['(no OMADIA_LOCAL_EMBEDDING_MODEL_DIR)'] : missingModelFiles(modelDir);
const skip =
  missing.length > 0
    ? `local embedding model not available: ${missing.join(', ')}`
    : false;

describe('the real local embedder', { skip }, () => {
  const client = () =>
    createLocalEmbeddingClient({
      modelDir: modelDir as string,
      maxInputChars: 8_000,
    });

  const cosine = (a: readonly number[], b: readonly number[]): number =>
    a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);

  it('emits normalised vectors of the promised width', async () => {
    const vector = await client().embed('Die Rechnung ist noch offen.');
    assert.equal(vector.length, LOCAL_EMBEDDING_DIMENSIONS);
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(norm - 1) < 1e-3, `expected a unit vector, got norm ${String(norm)}`);
  });

  it('separates German paraphrases from unrelated German text', async () => {
    const c = client();
    const invoice = await c.embed('Die Rechnung von der Muster GmbH über 1.200 Euro ist noch offen.');
    const same = await c.embed('Offener Rechnungsbetrag: 1200 EUR, Lieferant Muster GmbH.');
    const other = await c.embed('Das Sommerfest findet am 12. Juli im Hof statt.');

    const paraphrase = cosine(invoice, same);
    const unrelated = cosine(invoice, other);

    // The recommended threshold has to sit strictly between the two, or dedup
    // either merges unrelated notes or never fires.
    assert.ok(
      paraphrase > RECOMMENDED_DEDUP_THRESHOLD,
      `paraphrase ${paraphrase.toFixed(3)} must exceed the recommended threshold ${String(RECOMMENDED_DEDUP_THRESHOLD)}`,
    );
    assert.ok(
      unrelated < RECOMMENDED_DEDUP_THRESHOLD,
      `unrelated ${unrelated.toFixed(3)} must fall below the recommended threshold ${String(RECOMMENDED_DEDUP_THRESHOLD)}`,
    );
  });

  it('scores a punctuation-only duplicate above the recommendation and BELOW 0.90', async () => {
    // Measured: 0.892 for a sentence differing only in its final character.
    // Both bounds are the point. Above 0.45 means dedup catches it with the
    // recommended setting; below 0.90 means it would NOT be caught at the
    // knowledge graph default — a near-identical note would be stored twice,
    // silently. My first version of this test asserted `> 0.95` from memory of
    // a DIFFERENT model's number and failed; the bar is now the measurement.
    const c = client();
    const a = await c.embed('Die Rechnung von der Muster GmbH über 1.200 Euro ist noch offen.');
    const b = await c.embed('Die Rechnung von der Muster GmbH über 1.200 Euro ist noch offen!');
    const score = cosine(a, b);
    assert.ok(
      score > RECOMMENDED_DEDUP_THRESHOLD,
      `near-duplicate scored ${score.toFixed(3)}, must clear ${String(RECOMMENDED_DEDUP_THRESHOLD)}`,
    );
    assert.ok(
      score < 0.9,
      `near-duplicate scored ${score.toFixed(3)} — if it now clears 0.90 the dedup guidance is stale`,
    );
  });

  it('would NOT fire at the knowledge graph default of 0.90', async () => {
    // The negative control for the design decision. If a paraphrase ever does
    // clear 0.90 with this model, the manifest guidance and the activation log
    // are wrong and must change with it.
    const c = client();
    const paraphrase = cosine(
      await c.embed('Wir setzen für die Buchhaltung Odoo ein.'),
      await c.embed('Unsere Finanzbuchhaltung läuft über Odoo.'),
    );
    assert.ok(
      paraphrase < 0.9,
      `paraphrase scored ${paraphrase.toFixed(3)} — at or above 0.90 the dedup guidance in the manifest is stale`,
    );
  });
});
