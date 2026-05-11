import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { resolveBuilderReferenceCatalog } from '../../src/plugins/builder/builderReferenceCatalog.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../../src/plugins/manifestLoader.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPlugin = any;

function makeEntry(opts: {
  id: string;
  kind: 'agent' | 'integration' | 'channel' | 'extension';
  version: string;
  source_path: string;
}): PluginCatalogEntry {
  return {
    plugin: {
      id: opts.id,
      kind: opts.kind,
      version: opts.version,
    } as AnyPlugin,
    manifest: {},
    source_path: opts.source_path,
    source_kind: 'manifest-v1',
  };
}

function fakeCatalog(entries: PluginCatalogEntry[]): PluginCatalog {
  return {
    list: () => entries,
    get: (id: string) => entries.find((e) => e.plugin.id === id),
    load: async () => {},
  } as unknown as PluginCatalog;
}

describe('resolveBuilderReferenceCatalog', () => {
  it('always includes the four essentials (reference-maximum + seo-analyst + 2 boilerplates)', () => {
    const catalog = resolveBuilderReferenceCatalog(fakeCatalog([]));
    assert.ok(catalog['reference-maximum']);
    assert.ok(catalog['seo-analyst']);
    assert.ok(catalog['boilerplate']);
    assert.ok(catalog['boilerplate-pure-llm']);
  });

  it('auto-registers integration-kind plugins under `integration-<tail>`', () => {
    const catalog = resolveBuilderReferenceCatalog(
      fakeCatalog([
        makeEntry({
          id: 'de.byte5.integration.odoo',
          kind: 'integration',
          version: '0.1.0',
          source_path: '/abs/packages/harness-integration-odoo/manifest.yaml',
        }),
        makeEntry({
          id: 'de.byte5.integration.confluence',
          kind: 'integration',
          version: '0.1.2',
          source_path:
            '/abs/packages/harness-integration-confluence/manifest.yaml',
        }),
      ]),
    );
    assert.ok(catalog['integration-odoo']);
    assert.equal(
      catalog['integration-odoo']?.root,
      '/abs/packages/harness-integration-odoo',
    );
    assert.match(
      catalog['integration-odoo']?.description ?? '',
      /INTEGRATION\.md/,
    );
    assert.ok(catalog['integration-confluence']);
  });

  it('skips agent-kind / channel-kind / extension-kind plugins', () => {
    const catalog = resolveBuilderReferenceCatalog(
      fakeCatalog([
        makeEntry({
          id: 'de.byte5.agent.foo',
          kind: 'agent',
          version: '0.1.0',
          source_path: '/abs/packages/agent-foo/manifest.yaml',
        }),
        makeEntry({
          id: 'de.byte5.channel.bar',
          kind: 'channel',
          version: '0.1.0',
          source_path: '/abs/packages/channel-bar/manifest.yaml',
        }),
        makeEntry({
          id: 'de.byte5.tool.baz',
          kind: 'extension',
          version: '0.1.0',
          source_path: '/abs/packages/tool-baz/manifest.yaml',
        }),
      ]),
    );
    // No `<kind>-foo` / `<kind>-bar` keys appear.
    assert.equal(catalog['agent-foo'], undefined);
    assert.equal(catalog['channel-bar'], undefined);
    assert.equal(catalog['extension-baz'], undefined);
    // But essentials still present.
    assert.ok(catalog['seo-analyst']);
  });

  it('falls back to the full plugin id when two integrations share a tail', () => {
    const catalog = resolveBuilderReferenceCatalog(
      fakeCatalog([
        makeEntry({
          id: 'de.byte5.integration.odoo',
          kind: 'integration',
          version: '0.1.0',
          source_path: '/abs/a/manifest.yaml',
        }),
        makeEntry({
          id: 'com.acme.integration.odoo',
          kind: 'integration',
          version: '0.1.0',
          source_path: '/abs/b/manifest.yaml',
        }),
      ]),
    );
    // First wins under the short key.
    assert.equal(catalog['integration-odoo']?.root, '/abs/a');
    // Second goes under its full id.
    assert.equal(
      catalog['com.acme.integration.odoo']?.root,
      '/abs/b',
    );
  });

  it('keeps the `integration-` prefix as namespace separator from essentials', () => {
    // A plugin called `de.byte5.integration.boilerplate` registers under
    // `integration-boilerplate` — the prefix prevents it from shadowing
    // the `boilerplate` template essential.
    const catalog = resolveBuilderReferenceCatalog(
      fakeCatalog([
        makeEntry({
          id: 'de.byte5.integration.boilerplate',
          kind: 'integration',
          version: '0.1.0',
          source_path: '/abs/intruder/manifest.yaml',
        }),
      ]),
    );
    // Essential intact:
    assert.notEqual(catalog['boilerplate']?.root, '/abs/intruder');
    // Integration registered under its prefixed key:
    assert.equal(
      catalog['integration-boilerplate']?.root,
      '/abs/intruder',
    );
  });
});
