/**
 * OM-50 (#885) — every bundled plugin ships a German store description.
 *
 * The localization PATH has existed since #602: `identity.description` accepts
 * a `{ <locale>: text }` map, `adaptManifestV1` resolves the English side into
 * `Plugin.description` and passes the whole map along as
 * `description_localized`, `routes/store.ts` forwards it, and both render sites
 * (`PluginCard`, `store/[id]/page.tsx`) resolve it with `pickLocalized`.
 *
 * What was missing was the CONTENT: not one of the bundled manifests declared
 * a `de:` description, so a German operator read English in the store. Worse,
 * eleven manifests held GERMAN text in the bare string, which the loader reads
 * as English — so an English operator read German.
 *
 * This test is the regression guard for the content side. A new plugin without
 * a German description fails here rather than in a beta report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';

const PACKAGES = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'packages',
);

/** Em dash and en dash: the project's German copy uses commas or a full stop. */
const DASHES = /[—–]/;

/** Vocabulary that marks machine-written German in this project's conventions. */
const AI_TELLS = /nahtlos|leistungsstark|revolution(?:är|ar)|ermöglicht es Ihnen/i;

function bundledManifests(): Array<{ pkg: string; doc: Record<string, unknown> }> {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ pkg: e.name, file: join(PACKAGES, e.name, 'manifest.yaml') }))
    .filter((e) => existsSync(e.file))
    .map((e) => ({
      pkg: e.pkg,
      doc: YAML.parse(readFileSync(e.file, 'utf8')) as Record<string, unknown>,
    }));
}

test('every bundled manifest declares an English and a German description', () => {
  const manifests = bundledManifests();
  // Guard the guard: if the glob ever resolves to nothing, the assertions
  // below would all vacuously pass.
  assert.ok(manifests.length >= 20, `expected 20+ manifests, found ${manifests.length}`);

  const missing: string[] = [];
  for (const { pkg, doc } of manifests) {
    const identity = doc['identity'] as Record<string, unknown> | undefined;
    const description = identity?.['description'];
    if (
      !description ||
      typeof description !== 'object' ||
      Array.isArray(description)
    ) {
      missing.push(`${pkg}: description is not a locale map`);
      continue;
    }
    const map = description as Record<string, unknown>;
    for (const locale of ['en', 'de']) {
      const text = map[locale];
      if (typeof text !== 'string' || text.trim().length === 0) {
        missing.push(`${pkg}: missing ${locale}`);
      }
    }
  }
  assert.deepEqual(missing, [], `manifests without a full locale map:\n${missing.join('\n')}`);
});

test('German descriptions follow the project copy rules', () => {
  const offences: string[] = [];
  for (const { pkg, doc } of bundledManifests()) {
    const identity = doc['identity'] as Record<string, unknown> | undefined;
    const map = identity?.['description'] as Record<string, string> | undefined;
    const de = map?.['de'];
    if (typeof de !== 'string') continue;
    if (DASHES.test(de)) offences.push(`${pkg}: em/en dash in German description`);
    if (AI_TELLS.test(de)) offences.push(`${pkg}: AI-tell vocabulary in German description`);
  }
  assert.deepEqual(offences, [], offences.join('\n'));
});

test('the catalog projection carries the German text alongside the English one', () => {
  for (const { pkg, doc } of bundledManifests()) {
    const plugin = adaptManifestV1(doc);
    assert.ok(plugin, `${pkg}: manifest did not adapt`);
    const identity = doc['identity'] as Record<string, unknown>;
    const map = identity['description'] as Record<string, string>;
    // `description` stays the English string for search, the Hub and older
    // consumers; the full map rides along for the locale-aware render sites.
    assert.equal(plugin.description, map['en'], `${pkg}: English resolution`);
    assert.deepEqual(
      plugin.description_localized,
      map,
      `${pkg}: description_localized must carry every declared locale`,
    );
  }
});

test('a plain-string description still round-trips as English only', () => {
  // Third-party manifests are not required to localize. #602's shape must keep
  // working, and must NOT gain a description_localized key.
  const plugin = adaptManifestV1({
    schema_version: '1',
    identity: {
      id: '@vendor/plain',
      kind: 'tool',
      domain: 'test',
      name: 'Plain',
      version: '1.0.0',
      description: 'A plugin that never localized anything.',
    },
  });
  assert.ok(plugin);
  assert.equal(plugin.description, 'A plugin that never localized anything.');
  assert.equal(plugin.description_localized, undefined);
});

test('a German-only description resolves and is still passed along', () => {
  // The fallback chain has no English base here: `resolveLocalized` falls
  // through to the German text rather than emptying the card.
  const plugin = adaptManifestV1({
    schema_version: '1',
    identity: {
      id: '@vendor/de-only',
      kind: 'tool',
      domain: 'test',
      name: 'Nur Deutsch',
      version: '1.0.0',
      description: { de: 'Nur auf Deutsch beschrieben.' },
    },
  });
  assert.ok(plugin);
  assert.equal(plugin.description, 'Nur auf Deutsch beschrieben.');
  assert.deepEqual(plugin.description_localized, { de: 'Nur auf Deutsch beschrieben.' });
});
