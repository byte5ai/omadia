import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { renderManifestPreview } from '../../src/plugins/builder/manifestPreview.js';
import { CodegenError } from '../../src/plugins/builder/codegen.js';

/**
 * #1726 — the Builder keeps slot code on the draft, not in `spec.slots`.
 * The manifest preview must pass the draft's slots to codegen like the build
 * does, or every required slot reads as missing.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(): { spec: Record<string, unknown>; slots: Record<string, string> } {
  const raw = JSON.parse(
    readFileSync(path.join(HERE, 'fixtures', 'minimal-spec.json'), 'utf-8'),
  ) as Record<string, unknown>;
  const { slots, ...spec } = raw;
  return { spec, slots: slots as Record<string, string> };
}

describe('renderManifestPreview (#1726)', () => {
  it('renders the manifest when the slots come from the draft', async () => {
    const { spec, slots } = loadFixture();
    const yaml = await renderManifestPreview(spec as never, slots);
    assert.match(yaml, /^schema_version|identity:|id:/m);
    assert.doesNotMatch(yaml, /preview unavailable/);
  });

  it('without the draft slots codegen reports the required slots missing', async () => {
    const { spec } = loadFixture();
    await assert.rejects(
      renderManifestPreview(spec as never),
      (err: unknown) => err instanceof CodegenError,
    );
  });
});
