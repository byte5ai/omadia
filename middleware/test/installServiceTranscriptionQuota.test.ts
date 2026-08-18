/**
 * #584 — Verify `extractSetupSchema` auto-injects the synthetic
 * `_transcription_minutes_quota` field (per-agent monthly Billed-Minutes
 * quota, enforced by the metering layer) into every tool-contributing
 * plugin's setup schema — WITHOUT the manifest declaring it, exactly like
 * the `_privacy_mode` precedent.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { TRANSCRIPTION_MINUTES_QUOTA_CONFIG_KEY } from '@omadia/plugin-api';

import { extractSetupSchema } from '../src/plugins/installService.js';
import type { PluginCatalogEntry } from '../src/plugins/manifestLoader.js';

function entry(manifest: Record<string, unknown>): PluginCatalogEntry {
  // Cast — we only exercise the manifest-reading code paths; the rest
  // of the catalog-entry shape is irrelevant to `extractSetupSchema`.
  return { manifest } as unknown as PluginCatalogEntry;
}

describe('extractSetupSchema — synthetic _transcription_minutes_quota field', () => {
  it('shows on the install form without the manifest declaring it', () => {
    const schema = extractSetupSchema(
      entry({
        kind: 'integration',
        setup: { fields: [{ key: 'api_key', type: 'secret', label: 'API' }] },
      }),
    );
    assert.ok(schema);
    const keys = schema.fields.map((f) => f.key);
    assert.ok(keys.includes('api_key'), 'preserves author-declared fields');
    assert.ok(keys.includes(TRANSCRIPTION_MINUTES_QUOTA_CONFIG_KEY));
  });

  it('is an optional integer with NO default — empty means unlimited', () => {
    const schema = extractSetupSchema(entry({ kind: 'tool', setup: { fields: [] } }));
    assert.ok(schema);
    const f = schema.fields.find(
      (x) => x.key === TRANSCRIPTION_MINUTES_QUOTA_CONFIG_KEY,
    );
    assert.ok(f);
    assert.equal(f.type, 'integer');
    assert.equal(f.required, false);
    assert.equal(
      f.default,
      undefined,
      'a default would silently cap every agent — empty must mean unlimited',
    );
    assert.ok(f.label.de, 'kernel copy is German-tagged (#602/OM-17)');
    assert.ok(f.help?.de);
  });

  it('skips injection for channel-kind plugins (no tools, no agent quota)', () => {
    const schema = extractSetupSchema(
      entry({ kind: 'channel', setup: { fields: [] } }),
    );
    assert.ok(schema);
    const keys = schema.fields.map((f) => f.key);
    assert.ok(!keys.includes(TRANSCRIPTION_MINUTES_QUOTA_CONFIG_KEY));
  });
});
