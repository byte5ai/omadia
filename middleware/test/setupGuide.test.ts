import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

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
    assert.equal(plugin.required_secrets.length, 1);
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
