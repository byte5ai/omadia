import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateTree } from '../src/validator.js';

// Parity anchor: every canonical fixture must validate against the canonical
// schema. A new primitive ships only when its fixture lands green here — which
// is what keeps the desktop and mobile renderers honest against one contract.
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

describe('canonical fixtures validate against the schema', () => {
  it('covers all 24 primitives + the gallery', () => {
    expect(files.length).toBe(25);
  });

  for (const file of files) {
    it(`${file} is a valid canvas tree`, () => {
      const node: unknown = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
      const result = validateTree(node);
      expect(result.errors).toBeNull();
      expect(result.ok).toBe(true);
    });
  }
});
