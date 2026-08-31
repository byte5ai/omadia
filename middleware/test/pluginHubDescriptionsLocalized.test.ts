/**
 * OM-50 (#885) — English plugin descriptions leaked into the German Hub because
 * manifests declared `identity.description` as a bare single-language string.
 *
 * Mechanism (verified against `normalizeLocalized`/`pickLocalized`): a bare
 * string normalises to `{ en: … }`, so it carries NO `de`. The German Hub then
 * resolves `de → (miss) → en` and the operator reads English prose. (The reverse
 * also happens — a bare *German* string normalises to `{ en: <German> }` and
 * leaks German into the *English* Hub — but OM-50's betatest finding is the
 * English-into-German direction, so that is what this PR closes.)
 *
 * The localized-map path already exists (#602 / OM-28): a `{ en, de }` map on
 * `identity.description` rides along as `description_localized`, which the web-UI
 * resolves with `pickLocalized` (`PluginCard.tsx`). The Hub store list applies
 * NO kind filter (`routes/store.ts`) and the web-UI shows every kind under the
 * default tab, so both `kind:tool` plugins AND the localized extensions surface
 * to the operator.
 *
 * This test DISCOVERS manifests instead of hard-coding an allowlist, so a new
 * `kind:tool` shipped with a bare (English) description fails HERE — at the
 * exact silent-scope-cap that let OM-50 sit open across two betatest rounds —
 * instead of at the next tester's desk. Everything is read back out of the
 * produced catalog entry (`loadManifestFromPath`), never the raw YAML: that is
 * the value the Hub actually renders.
 */

import { strict as assert } from 'node:assert';
import { access, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { loadManifestFromPath } from '../src/plugins/manifestLoader.js';

const PACKAGES_DIR = fileURLToPath(new URL('../packages/', import.meta.url));

/**
 * Non-tool plugins that ARE Hub-visible and were English (or English-leaning),
 * so the German operator hit English prose — localized in this PR. Pinned by id
 * so a dropped German (or a revert to a bare string) fails loudly. The many
 * already-German extensions are deliberately NOT here: they read correctly for
 * the German operator; their reverse leak (German → English Hub) is lower
 * priority and out of this PR's scope.
 */
const EXTRA_LOCALIZED: ReadonlyArray<string> = [
  '@omadia/plugin-plan-runner',
  '@omadia/agent-seo-analyst',
  '@omadia/embeddings',
];

/** Load every package's manifest.yaml into its catalog entry (skips dirs
 *  without a manifest — e.g. `plugin-api`). */
async function loadAllManifestEntries() {
  const dirs = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const entries = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const manifestPath = `${PACKAGES_DIR}${d.name}/manifest.yaml`;
    // Skip package dirs without a manifest (e.g. `plugin-api`) before loading,
    // so the loader never logs a spurious ENOENT into the test output.
    const hasManifest = await access(manifestPath).then(
      () => true,
      () => false,
    );
    if (!hasManifest) continue;
    const entry = await loadManifestFromPath(manifestPath);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Assert the catalog entry's rendered German Hub value differs from English —
 *  i.e. the German operator does NOT fall through to English. */
function assertBilingual(entry: NonNullable<Awaited<ReturnType<typeof loadManifestFromPath>>>) {
  const id = entry.plugin.id;
  const map = entry.plugin.description_localized;
  assert.ok(
    map,
    `${id} must carry description_localized — a bare-string description leaks ` +
      `the wrong language into the Hub`,
  );
  const en = map['en'];
  const de = map['de'];
  assert.ok(en && en.trim().length > 0, `${id} description_localized.en must be non-empty`);
  assert.ok(de && de.trim().length > 0, `${id} description_localized.de must be non-empty`);
  // If de === en the German operator is still reading English — the whole point.
  assert.notEqual(de.trim(), en.trim(), `${id} German description must differ from English`);
  // Plugin.description (search, English UI, older consumers) stays the resolved
  // English string — the map is additive, never a regression for the English side.
  assert.equal(
    entry.plugin.description,
    en,
    `${id} resolved English description must equal description_localized.en`,
  );
}

describe('OM-50 — the German Hub never falls through to English', () => {
  it('every kind:tool plugin ships a bilingual (en+de) description', async () => {
    const entries = await loadAllManifestEntries();
    const tools = entries.filter(
      (e) => e.plugin.kind === 'tool' && e.plugin.is_reference_only !== true,
    );
    // Guard the discovery itself: if the glob finds nothing the assertions below
    // pass vacuously and the test would rot into a no-op.
    assert.ok(tools.length >= 5, `expected to discover the Hub tools, found ${tools.length}`);
    for (const entry of tools) assertBilingual(entry);
  });

  it('the extra Hub-visible plugins localized for the English leak stay bilingual', async () => {
    const entries = await loadAllManifestEntries();
    const byId = new Map(entries.map((e) => [e.plugin.id, e]));
    for (const id of EXTRA_LOCALIZED) {
      const entry = byId.get(id);
      assert.ok(entry, `${id} manifest must load (it is pinned as a localized Hub plugin)`);
      assertBilingual(entry);
    }
  });
});
