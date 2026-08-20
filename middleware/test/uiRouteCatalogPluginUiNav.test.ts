/**
 * #798 (epic #470 C9) — a scoped plugin id could not express a nav href.
 *
 * THE CONTRADICTION
 * -----------------
 * Core serves a plugin's bundled UI at `/p/:pluginId/ui/`, and Express
 * splits on a raw `/` — so `@acme/widget` only resolves percent-encoded
 * (`%40acme%2Fwidget`). Measured on a live core during the P5 acceptance
 * run: encoded 200, raw 404.
 *
 * `HREF_SEGMENT` rejects `%`, and rightly: the shell decides "core
 * destinations win" by comparing hrefs for string equality, which
 * percent-encoding defeats. So the only URL that worked was the only one
 * the validator refused, and the one it accepted 404'd in the browser.
 * Every `@scope/name` plugin hit it.
 *
 * THE FIX UNDER TEST
 * ------------------
 * The plugin states intent (`pluginUi: true`) and the kernel renders the
 * path from the id it already holds. The literal-href validator is
 * untouched — asserted explicitly below, because the tempting fix
 * (widening `HREF_SEGMENT` to admit `%xx`, which is what the acceptance run
 * patched locally to get unblocked) would weaken every literal href in
 * order to fix one path core can spell for itself.
 *
 * Mutation check, run while writing these: routing a `pluginUi` entry
 * through `assertInAppHref` fails case 1; dropping the flag from `listNav`
 * fails case 3; accepting `href` and `pluginUi` together fails case 5;
 * skipping the id charset check fails case 8.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  UiRouteCatalog,
  pluginUiHref,
} from '../src/platform/uiRouteCatalog.js';

const label = { en: 'Reports' } as const;

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * `uiRouteCatalog.ts` restates the manifest's plugin-id gate rather than
 * importing it, for the same reason `web-ui/app/_lib/pluginId.ts` does
 * (C8b): `manifestLoader.ts` keeps those declarations in the exact source
 * form a parity test anchors on, and exporting them would reformat the very
 * lines being matched.
 *
 * So the restatement is pinned the same way. A comment claiming two
 * definitions agree is worth nothing; this makes drift fail a test rather
 * than a nav entry.
 */
describe('#798 plugin-id gate parity with manifestLoader', () => {
  it('restates PLUGIN_ID_PATTERN character-identically', async () => {
    const authority = await readFile(
      resolve(srcDir, 'plugins', 'manifestLoader.ts'),
      'utf8',
    );
    const copy = await readFile(
      resolve(srcDir, 'platform', 'uiRouteCatalog.ts'),
      'utf8',
    );
    const authoritative = /^const PLUGIN_ID_PATTERN = (\/.*\/);$/m.exec(
      authority,
    );
    assert.ok(
      authoritative,
      'could not find `const PLUGIN_ID_PATTERN = /…/;` in manifestLoader.ts — ' +
        'if it was renamed or reformatted, update this test and the copy in ' +
        'uiRouteCatalog.ts together',
    );
    const restated = /^const ENCODABLE_PLUGIN_ID =\n {2}(\/.*\/);$/m.exec(copy);
    assert.ok(restated, 'could not find ENCODABLE_PLUGIN_ID in uiRouteCatalog.ts');
    assert.equal(restated[1], authoritative[1]);
  });

  it('restates PLUGIN_ID_MAX_LENGTH character-identically', async () => {
    const authority = await readFile(
      resolve(srcDir, 'plugins', 'manifestLoader.ts'),
      'utf8',
    );
    const copy = await readFile(
      resolve(srcDir, 'platform', 'uiRouteCatalog.ts'),
      'utf8',
    );
    const a = /^const PLUGIN_ID_MAX_LENGTH = (\d+);$/m.exec(authority);
    const b = /^const PLUGIN_ID_MAX_LENGTH = (\d+);$/m.exec(copy);
    assert.ok(a && b);
    assert.equal(b[1], a[1]);
  });
});

describe('UiRouteCatalog — pluginUi nav entries (#798)', () => {
  it('renders the canonical encoded host-page path for a scoped plugin id', () => {
    const cat = new UiRouteCatalog();
    cat.registerNav('@acme/widget', {
      navId: 'main',
      pluginUi: true,
      cluster: 'adminCluster',
      label,
    });

    const entry = cat.listNav('en')[0];
    assert.equal(entry?.href, '/plugin-ui/%40acme%2Fwidget');
    assert.equal(entry?.pluginId, '@acme/widget');
    assert.equal(
      entry?.href,
      pluginUiHref('@acme/widget'),
      'the catalogue and the exported helper must agree on one spelling — ' +
        'the web UI mirrors this derivation and a second literal would drift',
    );
  });

  it('leaves an unscoped id unencoded — encoding is not blanket-applied', () => {
    const cat = new UiRouteCatalog();
    cat.registerNav('reporter', { navId: 'main', pluginUi: true, label });
    assert.equal(cat.listNav('en')[0]?.href, '/plugin-ui/reporter');
  });

  it('flags the entry so the shell can re-derive the href itself', () => {
    const cat = new UiRouteCatalog();
    cat.registerNav('@acme/widget', { navId: 'main', pluginUi: true, label });
    assert.equal(cat.listNav('en')[0]?.pluginUi, true);
  });

  it('does NOT flag a literal-href entry', () => {
    const cat = new UiRouteCatalog();
    cat.registerNav('@acme/widget', {
      navId: 'main',
      href: '/admin/reports',
      label,
    });
    const entry = cat.listNav('en')[0];
    assert.equal(entry?.href, '/admin/reports');
    assert.equal(entry?.pluginUi, undefined);
  });

  it('refuses href and pluginUi together — the destination must be unambiguous', () => {
    const cat = new UiRouteCatalog();
    assert.throws(
      () =>
        cat.registerNav('@acme/widget', {
          navId: 'main',
          href: '/admin/reports',
          pluginUi: true,
          label,
        }),
      /either 'href' or 'pluginUi: true', not both/,
    );
  });

  it('refuses an entry with neither', () => {
    const cat = new UiRouteCatalog();
    assert.throws(
      () => cat.registerNav('@acme/widget', { navId: 'main', label }),
      /needs a destination/,
    );
  });

  it('refuses a non-literal-true pluginUi rather than coercing it', () => {
    const cat = new UiRouteCatalog();
    assert.throws(
      () =>
        cat.registerNav('@acme/widget', {
          navId: 'main',
          pluginUi: 'yes' as unknown as true,
          label,
        }),
      /pluginUi must be literal/,
    );
  });

  it('refuses to encode a plugin id that never passed the manifest charset gate', () => {
    const cat = new UiRouteCatalog();
    for (const badId of ['../etc', 'Has Spaces', '@acme/UPPER', 'a/b/c']) {
      assert.throws(
        () => cat.registerNav(badId, { navId: 'main', pluginUi: true, label }),
        /npm-style plugin id/,
        `id '${badId}' must not reach the shell's chrome percent-encoded`,
      );
    }
  });

  it('KEEPS the literal-href validator strict — percent-encoding still refused', () => {
    const cat = new UiRouteCatalog();
    assert.throws(
      () =>
        cat.registerNav('@acme/widget', {
          navId: 'main',
          href: '/plugin-ui/%40acme%2Fwidget',
          label,
        }),
      /percent-encoding/,
    );
    assert.throws(
      () =>
        cat.registerNav('@acme/widget', {
          navId: 'other',
          href: '/x/%2e%2e/admin',
          label,
        }),
      /percent-encoding/,
    );
  });

  it('disposes a pluginUi entry like any other', () => {
    const cat = new UiRouteCatalog();
    const dispose = cat.registerNav('@acme/widget', {
      navId: 'main',
      pluginUi: true,
      label,
    });
    assert.equal(cat.navSize(), 1);
    dispose();
    assert.equal(cat.navSize(), 0);
  });
});
