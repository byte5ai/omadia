/**
 * Privacy Shield v4 — the render-vs-export contract is stated once (#1215).
 *
 * `v4/promptText.ts` holds both halves, and the render tool's description and
 * the dataset digest interpolate them. This pins that they still do, that the
 * tool description carries no capitalised ALWAYS again, and that the export
 * half sends only spreadsheet downloads to the export tool.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import {
  buildDigest,
  digestToToolResultText,
} from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import {
  FILE_EXPORT_EXCEPTION,
  RENDER_CONTRACT,
} from '@omadia/plugin-privacy-guard/dist/v4/promptText.js';
import { RENDER_TOOL_SPEC } from '@omadia/plugin-privacy-guard/dist/v4/toolDefs.js';

const ROWS = Array.from({ length: 4 }, (_, i) => ({
  employee_id: String(1000 + i),
  days: i + 1,
}));

describe('privacy v4 — render-vs-export contract (#1215)', () => {
  it('the render tool description carries both halves and no capitalised ALWAYS', () => {
    assert.ok(RENDER_TOOL_SPEC.description.includes(RENDER_CONTRACT));
    assert.ok(RENDER_TOOL_SPEC.description.includes(FILE_EXPORT_EXCEPTION));
    assert.doesNotMatch(RENDER_TOOL_SPEC.description, /\bALWAYS\b/);
  });

  it('the dataset digest carries both halves', () => {
    const store = createDatasetStore({
      classify: createShapeClassifier(),
      buildDigest,
      turnId: 'turn-test',
    });
    const { digest } = store.internToolResult('hr.leave', ROWS);
    const text = digestToToolResultText(digest);
    assert.ok(text.includes(RENDER_CONTRACT));
    assert.ok(text.includes(FILE_EXPORT_EXCEPTION));
  });

  it('the export half sends only spreadsheet downloads to the export tool', () => {
    assert.match(FILE_EXPORT_EXCEPTION, /downloadable spreadsheet/);
    assert.doesNotMatch(FILE_EXPORT_EXCEPTION, /report document/);
    assert.match(FILE_EXPORT_EXCEPTION, /Word document cannot take a datasetId/);
  });
});
