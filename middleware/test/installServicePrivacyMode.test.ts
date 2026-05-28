/**
 * Slice 2.5 — Verify `extractSetupSchema` auto-injects the synthetic
 * `_privacy_mode` and `_privacy_bypass_scopes` fields into every
 * tool-contributing plugin's setup schema, and that a manifest
 * `privacy.recommendation` block surfaces in the help text.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  PRIVACY_BYPASS_SCOPES_CONFIG_KEY,
  PRIVACY_MODE_CONFIG_KEY,
  PRIVACY_MODE_DEFAULT,
} from '@omadia/plugin-api';

import { extractSetupSchema } from '../src/plugins/installService.js';
import type { PluginCatalogEntry } from '../src/plugins/manifestLoader.js';

function entry(manifest: Record<string, unknown>): PluginCatalogEntry {
  // Cast — we only exercise the manifest-reading code paths; the rest
  // of the catalog-entry shape is irrelevant to `extractSetupSchema`.
  return { manifest } as unknown as PluginCatalogEntry;
}

describe('extractSetupSchema — synthetic _privacy_mode field', () => {
  it('injects _privacy_mode + _privacy_bypass_scopes for integration kind', () => {
    const schema = extractSetupSchema(
      entry({
        kind: 'integration',
        setup: { fields: [{ key: 'api_key', type: 'secret', label: 'API' }] },
      }),
    );
    assert.ok(schema);
    const keys = schema.fields.map((f) => f.key);
    assert.ok(keys.includes('api_key'), 'preserves author-declared fields');
    assert.ok(keys.includes(PRIVACY_MODE_CONFIG_KEY));
    assert.ok(keys.includes(PRIVACY_BYPASS_SCOPES_CONFIG_KEY));
  });

  it('_privacy_mode is enum/guarded-by-default, not required', () => {
    const schema = extractSetupSchema(entry({ kind: 'tool', setup: { fields: [] } }));
    assert.ok(schema);
    const f = schema.fields.find((x) => x.key === PRIVACY_MODE_CONFIG_KEY);
    assert.ok(f);
    assert.equal(f.type, 'enum');
    assert.equal(f.default, PRIVACY_MODE_DEFAULT);
    assert.equal(f.required, false);
    const values = (f.enum ?? []).map((o) => o.value);
    assert.deepEqual(values, ['guarded', 'bypass', 'per_tool']);
  });

  it('skips injection for channel-kind plugins (no tools)', () => {
    const schema = extractSetupSchema(
      entry({ kind: 'channel', setup: { fields: [] } }),
    );
    assert.ok(schema);
    const keys = schema.fields.map((f) => f.key);
    assert.ok(
      !keys.includes(PRIVACY_MODE_CONFIG_KEY),
      'channel plugins have no LLM tools — no privacy field needed',
    );
  });

  it('surfaces manifest.privacy.recommendation in the help text', () => {
    const schema = extractSetupSchema(
      entry({
        kind: 'integration',
        setup: { fields: [] },
        privacy: {
          recommendation: {
            mode: 'bypass',
            reason: 'Document-shaped bodies; v4 cannot summarize structurally.',
          },
        },
      }),
    );
    const f = schema?.fields.find((x) => x.key === PRIVACY_MODE_CONFIG_KEY);
    assert.ok(f?.help);
    assert.ok(f.help.includes('📌'), 'help text marks the author recommendation');
    assert.ok(f.help.includes('Bypass'), 'help text names the recommended mode');
    assert.ok(
      f.help.includes('Document-shaped bodies'),
      'help text includes the author reason',
    );
  });

  it('ignores malformed privacy.recommendation gracefully', () => {
    for (const garbage of [
      { recommendation: { mode: 'guarded' } }, // missing reason ok
      { recommendation: { mode: 'INVALID' } }, // bad mode
      { recommendation: 'not-an-object' },
      { recommendation: { mode: 42 } },
    ]) {
      const schema = extractSetupSchema(
        entry({ kind: 'integration', setup: { fields: [] }, privacy: garbage }),
      );
      const f = schema?.fields.find((x) => x.key === PRIVACY_MODE_CONFIG_KEY);
      assert.ok(f);
      // For invalid recommendations the help text falls back to the base
      // text (no 📌 prefix). For the lone valid `{mode: 'guarded'}` case
      // a 📌 IS present (mode is a valid value) — assert via mode check.
      const rec = (garbage as { recommendation?: { mode?: unknown } })
        .recommendation;
      const validMode =
        typeof rec === 'object' &&
        rec !== null &&
        typeof rec.mode === 'string' &&
        ['guarded', 'bypass', 'per_tool'].includes(rec.mode);
      if (!validMode) {
        assert.ok(
          !(f.help ?? '').includes('📌'),
          'invalid recommendation must not surface as a hint',
        );
      }
    }
  });
});
