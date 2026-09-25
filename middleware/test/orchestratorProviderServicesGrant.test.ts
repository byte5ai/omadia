/**
 * #1076 part 2 — `@omadia/orchestrator` resolves `llmProviderCatalog` and
 * `installedPluginConfigReader`, both kernel-published at boot. Until this fix
 * it held them only through its row in `BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20`.
 * Now the manifest declares them under `optional_requires` and the row no
 * longer lists them, so the allowlist shrinks by two.
 *
 * `pluginServiceGrantCoverage.test.ts` already fails when a resolved name is
 * neither declared nor allowlisted. This file pins the specific shape: the
 * names are declared as OPTIONAL, resolved with the matching verb, absent from
 * the legacy row, and still resolvable through a context built from the real
 * manifest.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseDocument } from 'yaml';
import { parseCapabilityRef } from '@omadia/plugin-api';

import {
  loadManifestFromPath,
  type PluginCatalog,
} from '../src/plugins/manifestLoader.js';
import { createPluginContext } from '../src/platform/pluginContext.js';
import type { CreatePluginContextOptions } from '../src/platform/pluginContext.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import {
  BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20,
  legacyServiceGrantsFor,
} from '../src/platform/pluginServiceGrants.js';

const MIDDLEWARE_ROOT = path.resolve(import.meta.dirname, '..');
const ORCH = '@omadia/orchestrator';
const MANIFEST = path.join(MIDDLEWARE_ROOT, 'packages/harness-orchestrator/manifest.yaml');
const PLUGIN_SOURCE = path.join(MIDDLEWARE_ROOT, 'packages/harness-orchestrator/src/plugin.ts');
const NAMES = ['llmProviderCatalog', 'installedPluginConfigReader'] as const;

function optionalRequiresNames(): string[] {
  const doc = parseDocument(readFileSync(MANIFEST, 'utf8'));
  const raw = doc.get('optional_requires') as { toJSON?: () => unknown } | null;
  const list = raw?.toJSON?.();
  assert.ok(Array.isArray(list), 'optional_requires must be a list');
  return (list as unknown[])
    .filter((e): e is string => typeof e === 'string')
    .map((e) => parseCapabilityRef(e).name);
}

describe('orchestrator declares its kernel provider services (#1076)', () => {
  it('lists both names under optional_requires', () => {
    const names = optionalRequiresNames();
    for (const name of NAMES) {
      assert.ok(names.includes(name), `optional_requires must list '${name}@1' (found: ${names.join(', ')})`);
    }
  });

  it('no longer carries either name in the legacy allowlist row', () => {
    const row = BUNDLED_LEGACY_SERVICE_GRANTS_2026_08_20[ORCH] ?? [];
    for (const name of NAMES) {
      assert.ok(!row.includes(name), `the @omadia/orchestrator legacy row must not list '${name}'`);
    }
  });

  it('a context built from the real manifest resolves both through the declaration alone', async () => {
    const entry = await loadManifestFromPath(MANIFEST);
    assert.ok(entry, 'the orchestrator manifest must load');
    const bundledEntry = { ...entry, origin: 'bundled' as const };
    const catalog = {
      get: (id: string) => (id === ORCH ? bundledEntry : undefined),
      list: () => [bundledEntry],
      isBundledId: (id: string) => id === ORCH,
    } as unknown as PluginCatalog;
    for (const name of NAMES) {
      assert.ok(
        !legacyServiceGrantsFor(ORCH, catalog).includes(name),
        `'${name}' must not come from the legacy row`,
      );
    }

    const registry = new ServiceRegistry();
    const catalogService = { get: () => undefined };
    const configReader = (): unknown => undefined;
    registry.provide('llmProviderCatalog', catalogService);
    registry.provide('installedPluginConfigReader', configReader);

    const stub = (): (() => void) => (): void => {};
    const ctx = createPluginContext({
      agentId: ORCH,
      vault: {
        get: async (): Promise<undefined> => undefined,
        listKeys: async (): Promise<string[]> => [],
      },
      registry: { has: () => true, list: () => [], get: () => undefined },
      catalog,
      serviceRegistry: registry,
      nativeToolRegistry: { register: stub, registerHandler: stub },
      routeRegistry: { register: stub, disposeBySource: () => 0 },
      jobScheduler: { register: stub, stopForPlugin: (): void => {} },
      notificationRouter: { dispatch: (): void => {}, registerChannel: stub },
      uiRouteCatalog: { register: stub, registerNav: stub },
      logger: (): void => {},
    } as unknown as CreatePluginContextOptions);

    assert.equal(ctx.services.getOptional('llmProviderCatalog'), catalogService);
    assert.equal(ctx.services.get('llmProviderCatalog'), catalogService);
    assert.equal(ctx.services.getOptional('installedPluginConfigReader'), configReader);
    assert.equal(ctx.services.get('installedPluginConfigReader'), configReader);
  });

  it('plugin.ts resolves both with getOptional, the verb optional_requires pairs with', () => {
    const source = readFileSync(PLUGIN_SOURCE, 'utf8');
    // The type argument may span lines and contain parens (a function type),
    // but must not run into another `ctx.services` call.
    const typeArg = '(?:(?!ctx\\.services)[\\s\\S]){0,200}?';
    for (const name of NAMES) {
      assert.match(
        source,
        new RegExp(`ctx\\.services\\.getOptional<${typeArg}>\\(\\s*'${name}'\\s*,?\\s*\\)`),
        `plugin.ts must resolve '${name}' via ctx.services.getOptional`,
      );
      assert.doesNotMatch(
        source,
        new RegExp(`ctx\\.services\\.get<${typeArg}>\\(\\s*'${name}'\\s*,?\\s*\\)`),
        `plugin.ts must not resolve '${name}' with the hard-require verb`,
      );
    }
  });
});
