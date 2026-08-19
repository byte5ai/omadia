/**
 * PR #326 — the producer side: `resolveDatasetForRender` must carry the
 * classification, not just the path.
 *
 * ## Why this file exists
 *
 * The renderer-side tests (`canvasPublishMaskedColumns.test.ts`) feed a column
 * schema straight into the composer, so they never execute the privacy-guard
 * service that produces it. A mutation run caught that: **deleting
 * `classification: f.classification` from `resolveDatasetForRender` failed no
 * test at all.** Every guard badge in the product would have disappeared while
 * the suite stayed green.
 *
 * The verdict has always existed on the interned dataset; it was simply dropped
 * at the boundary. So the assertions run against the **real service** — a fake
 * would only prove that the fake forwards it.
 *
 * Note for future mutation runs: this suite imports
 * `@omadia/plugin-privacy-guard/dist`, so a `src`-only mutation is invisible
 * until the package is rebuilt.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

interface DigestField {
  path: string;
  classification: string;
}

/** The digest is prose followed by one JSON object; the verdicts live in it. */
function digestFields(digestText: string): DigestField[] {
  const start = digestText.indexOf('{');
  assert.notEqual(start, -1, 'the digest must carry a JSON payload');
  const parsed = JSON.parse(digestText.slice(start)) as { fields?: DigestField[] };
  const fields = parsed.fields ?? [];
  assert.ok(fields.length > 0, 'the digest must describe its fields');
  return fields;
}

async function intern(svc: ReturnType<typeof createPrivacyGuardService>, turnId: string, rows: unknown[]) {
  return svc.internToolResultV4({
    sessionId: `session-${turnId}`,
    turnId,
    toolName: 'odoo_fetch_dataset',
    rawResult: JSON.stringify(rows),
  });
}

describe('PR #326 — resolveDatasetForRender carries the classification', () => {
  it('returns a verdict per column, and both verdicts are representable', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 'turn-326';
    // `partner` is unique per row and name-shaped → masked; `amount` is
    // numeric → cleartext. The point is not WHICH verdict the classifier
    // reaches, but that whichever it reaches survives the boundary.
    const interned = await intern(svc, turnId, [
      { partner: 'Acme GmbH', amount: 100 },
      { partner: 'Beta AG', amount: 200 },
      { partner: 'Gamma KG', amount: 300 },
    ]);
    const resolved = svc.resolveDatasetForRender?.(turnId, interned.datasetId);
    assert.ok(resolved, 'dataset resolves within the turn');

    for (const column of resolved.columns) {
      assert.ok(
        column.classification === 'sensitive-masked' ||
          column.classification === 'safe-cleartext',
        `column ${column.path} must carry a verdict, got ${String(column.classification)}`,
      );
    }
    // A resolver that hard-coded either value would satisfy the loop above.
    assert.equal(
      new Set(resolved.columns.map((c) => c.classification)).size,
      2,
      'both verdicts must be representable',
    );
  });

  it('forwards the interned verdict rather than re-deciding it', async () => {
    // Two sources of truth for the same column would drift, and the one the
    // renderer sees is this one. Compared against the digest the model was
    // handed, so the two cannot disagree without a test noticing.
    const svc = createPrivacyGuardService();
    const turnId = 'turn-326-b';
    const interned = await intern(svc, turnId, [
      { employee_id: 'E-1', full_name: 'Anna Becker', salary: 50000 },
      { employee_id: 'E-2', full_name: 'Bernd Roth', salary: 60000 },
      { employee_id: 'E-3', full_name: 'Clara Diehl', salary: 70000 },
    ]);
    const resolved = svc.resolveDatasetForRender?.(turnId, interned.datasetId);
    assert.ok(resolved);

    const fields = digestFields(interned.digestText);
    for (const field of fields) {
      // Explicit annotation: `assert.ok` is an assertion function, and letting
      // TS infer through it makes the binding circular (TS7022).
      const column: { path: string; classification?: string } | undefined =
        resolved.columns.find((c) => c.path === field.path);
      assert.ok(column, `column ${field.path} must survive to the render boundary`);
      assert.equal(
        column.classification,
        field.classification,
        `column ${field.path} must keep the interned verdict`,
      );
    }
    // And the comparison must not be vacuous: at least one masked column has
    // to be in play, or this proves only that cleartext survives.
    assert.ok(
      fields.some((f) => f.classification === 'sensitive-masked'),
      'this fixture must produce at least one masked column',
    );
  });
});
