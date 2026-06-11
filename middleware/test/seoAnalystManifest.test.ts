/**
 * #91 — the SEO analyst is a web_scanner that declares `public-web` as its
 * default audit mode, so it can fetch user-supplied public URLs (any domain)
 * out of the box. The kernel still confines non-web_scanner plugins to
 * single-host and the SSRF guard blocks private addresses at connect time;
 * those invariants are covered by httpAccessor.test.ts. This test pins that the
 * manifest declares the intent and the loader surfaces it.
 */

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

describe('agent-seo-analyst manifest — network audit policy', () => {
  it('declares web_scanner + public-web default audit mode', async () => {
    const manifestPath = fileURLToPath(
      new URL('../packages/agent-seo-analyst/manifest.yaml', import.meta.url),
    );
    const entry = await loadManifestFromPath(manifestPath);
    assert.ok(entry, 'manifest loads as a valid schema-v1 document');
    assert.equal(entry.plugin.id, '@omadia/agent-seo-analyst');
    assert.equal(entry.plugin.permissions_summary.network_web_scanner, true);
    assert.equal(
      entry.plugin.permissions_summary.network_default_audit_mode,
      'public-web',
    );
  });
});
