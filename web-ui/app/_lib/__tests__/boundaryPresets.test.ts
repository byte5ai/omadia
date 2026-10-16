import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BOUNDARY_PRESETS } from '../boundaryPresets';

/**
 * #1104 — the web UI renders the "Boundaries" tab from its own copy of the
 * preset library (web-ui has no runtime dependency on middleware packages).
 * The library of record is `BOUNDARY_PRESETS` in `@omadia/plugin-api`, which
 * both the builder and the Quality Guard plugin read. The copy is pinned here,
 * the same way `pluginId.test.ts` pins the id gate: the source is read as
 * text, so an id, category or label key that drifts fails this test instead
 * of offering operators a preset the server does not know.
 */

const SHARED_LIBRARY = path.resolve(
  __dirname,
  '../../../../middleware/packages/plugin-api/src/boundaryPresets.ts',
);

function sharedPresets(): Array<{ id: string; category: string; labelKey: string }> {
  const source = readFileSync(SHARED_LIBRARY, 'utf-8');
  const entry =
    /\{\s*id: '([^']+)',\s*category: '([^']+)',\s*labelKey: '([^']+)',/g;
  return [...source.matchAll(entry)].map(([, id, category, labelKey]) => ({
    id: id as string,
    category: category as string,
    labelKey: labelKey as string,
  }));
}

describe('web-ui boundary presets mirror the plugin-api library', () => {
  it('reads the shared library (guards the parser itself)', () => {
    expect(sharedPresets()).toHaveLength(12);
  });

  it('has the same ids, categories and label keys, in the same order', () => {
    expect(BOUNDARY_PRESETS.map(({ id, category, labelKey }) => ({ id, category, labelKey }))).toEqual(
      sharedPresets(),
    );
  });
});
