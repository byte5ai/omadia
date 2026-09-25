import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';

// The manifest's `setup.guide` (a `{ <locale>: markdown }` map) must reach the
// store `Plugin` so the web-ui can render a localized third-party installation
// guide. This covers the LOCAL plugin path (adaptManifestV1); the
// remote/registry path is covered in registryInstallMerge.test.ts.

function baseManifest(setup: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id: '@omadia/channel-discord',
      name: 'Discord',
      version: '0.1.0',
      kind: 'channel',
      domain: 'discord',
    },
    compat: { core: '>=1.0 <2.0' },
    setup,
  };
}

describe('adaptManifestV1 · setup.guide', () => {
  it('lifts a localized setup.guide map onto Plugin.setup_guide', () => {
    const guide = {
      en: '## Create a Discord bot\n1. Open the Developer Portal',
      de: '## Discord-Bot anlegen\n1. Developer Portal öffnen',
    };
    const plugin = adaptManifestV1(
      baseManifest({
        guide,
        fields: [
          { key: 'discord_bot_token', type: 'secret', label: 'Token', required: true },
        ],
      }),
    );
    assert.ok(plugin);
    assert.deepEqual(plugin.setup_guide, guide);
    // Coexists with the existing per-field hints.
    assert.equal(plugin.setup_fields.length, 1);
  });

  it('drops empty-string locales and keeps the rest', () => {
    const plugin = adaptManifestV1(
      baseManifest({ guide: { en: 'real guide', de: '   ' }, fields: [] }),
    );
    assert.ok(plugin);
    assert.deepEqual(plugin.setup_guide, { en: 'real guide' });
  });

  it('tolerates a bare string by treating it as English', () => {
    const plugin = adaptManifestV1(
      baseManifest({ guide: '## Just one language', fields: [] }),
    );
    assert.ok(plugin);
    assert.deepEqual(plugin.setup_guide, { en: '## Just one language' });
  });

  it('leaves setup_guide undefined when the manifest declares none', () => {
    const plugin = adaptManifestV1(baseManifest({ fields: [] }));
    assert.ok(plugin);
    assert.equal(plugin.setup_guide, undefined);
  });

  it('treats an all-empty guide map as absent', () => {
    const plugin = adaptManifestV1(baseManifest({ guide: { en: '', de: '' }, fields: [] }));
    assert.ok(plugin);
    assert.equal(plugin.setup_guide, undefined);
  });
});

// #1075 — the office setup guide was written, bumped to 0.1.2 and published to
// the Hub from a working tree that was never committed, so the repository never
// had it. This guards the restored block against being dropped again.
describe('bundled manifest · @omadia/plugin-office setup.guide (#1075)', () => {
  it('ships an en + de guide covering the bucket and the public base URL', () => {
    const file = join(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      'packages',
      'harness-plugin-office',
      'manifest.yaml',
    );
    const doc = YAML.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const plugin = adaptManifestV1(doc);
    assert.ok(plugin);
    const guide = plugin.setup_guide;
    assert.ok(guide, 'the office manifest declares no setup.guide');
    for (const locale of ['en', 'de']) {
      const text: string | undefined = guide[locale];
      assert.ok(typeof text === 'string' && text.trim().length > 0, `missing ${locale} guide`);
      assert.match(text, /Tigris/);
      assert.match(text, /base URL|Base-URL/i);
    }
  });
});
