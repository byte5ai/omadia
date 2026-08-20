/**
 * Epic #470 C8 end to end: a plugin ships a multi-file SPA, core serves it,
 * and the two things that must be impossible stay impossible.
 *
 * This is the abandonment-checkpoint proof. It takes the throwaway bundle in
 * `test/fixtures/plugin-ui-proof/`, zips it, pushes it through the REAL
 * `PackageUploadService.ingest` (extractor guardrails, manifest validation,
 * entry-point check, the new arbitrary-value scan), then mounts the resulting
 * package directory on a real Express app and fetches it back over the real
 * router — including the stylesheet the bundle links instead of shipping.
 *
 * The two negative cases are the point of the design, not extras:
 *   - a `.css` file inside `ui/` is rejected at extraction. The inability to
 *     ship CSS IS the enforcement for the Tailwind vocabulary
 *     (`implementation.md` §1 row 3);
 *   - an arbitrary value inside the bundle is rejected at ingest, because it
 *     would otherwise render unstyled with no error anywhere.
 */

import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Express } from 'express';

import { PackageUploadService } from '../src/plugins/packageUploadService.js';
import { createHarnessAdminUiRouter } from '../src/routes/harnessAdminUi.js';
import { createPluginUiStaticRouter } from '../src/routes/pluginUiStatic.js';
import {
  buildZip,
  fakeCatalog,
  fakeStore,
  manifestYaml,
} from './_helpers/pluginPackageZip.js';
import { invoke } from './_helpers/httpInvoke.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'plugin-ui-proof');
const MIDDLEWARE_ROOT = path.resolve(HERE, '..');
const PLUGIN_UI_ASSETS = path.join(MIDDLEWARE_ROOT, 'assets', 'plugin-ui');

const PLUGIN_ID = 'plugin-ui-proof';
const VERSION = '1.0.0';

const LIMITS = { maxBytes: 4_000_000, maxExtractedBytes: 4_000_000, maxEntries: 200 };

let indexHtml: string;
let appJs: string;

async function fixtureFiles(): Promise<Record<string, string>> {
  return {
    'manifest.yaml': manifestYaml(PLUGIN_ID, VERSION),
    'package.json': JSON.stringify({ name: PLUGIN_ID, version: VERSION }, null, 2),
    'dist/plugin.js': 'module.exports = { activate() {} };\n',
    'ui/index.html': indexHtml,
    'ui/assets/app-7c1f4b2e.js': appJs,
  };
}

function service(packagesDir: string): PackageUploadService {
  return new PackageUploadService({
    store: fakeStore(),
    catalog: fakeCatalog(),
    packagesDir,
    limits: LIMITS,
    hostDependencies: {},
    log: () => {},
  });
}

before(async () => {
  indexHtml = await fs.readFile(path.join(FIXTURE, 'ui', 'index.html'), 'utf-8');
  appJs = await fs.readFile(
    path.join(FIXTURE, 'ui', 'assets', 'app-7c1f4b2e.js'),
    'utf-8',
  );
});

describe('plugin UI proof — install through the package store path', () => {
  let packagesDir: string;
  let app: Express;
  let packageRoot: string;

  before(async () => {
    packagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-ui-proof-'));
    const zip = await buildZip(await fixtureFiles());
    const result = await service(packagesDir).ingest({
      fileBuffer: zip,
      originalFilename: 'plugin-ui-proof.zip',
      uploadedBy: 'test',
    });
    assert.equal(
      result.ok,
      true,
      `ingest failed: ${result.ok ? '' : `${result.code} ${result.message}`}`,
    );
    assert.ok(result.ok);
    packageRoot = result.package.path;

    app = express();
    app.use('/api/_harness', await createHarnessAdminUiRouter({
      assetsRoot: PLUGIN_UI_ASSETS,
    }));
    app.use(
      '/p',
      createPluginUiStaticRouter({
        resolvePackageRoot: (id) => (id === PLUGIN_ID ? packageRoot : undefined),
      }),
    );
  });

  after(async () => {
    await fs.rm(packagesDir, { recursive: true, force: true });
  });

  it('lands the multi-file ui/ bundle on disk', async () => {
    await fs.access(path.join(packageRoot, 'ui', 'index.html'));
    await fs.access(path.join(packageRoot, 'ui', 'assets', 'app-7c1f4b2e.js'));
  });

  it('serves index.html as HTML', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/index.html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(res.text, /Plugin UI proof/);
  });

  it('serves the hashed JS bundle immutably', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/app-7c1f4b2e.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  it('ships no stylesheet of its own — it links the one core serves', () => {
    assert.ok(!indexHtml.includes('.css"') || indexHtml.includes('_harness/plugin-ui.css'));
    assert.match(indexHtml, /\/bot-api\/_harness\/plugin-ui\.css/);
  });

  it('serves that stylesheet, with the Lume utilities the bundle uses', async () => {
    const res = await invoke(app, 'GET', '/api/_harness/plugin-ui.css');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
    for (const utility of [
      '.bg-accent',
      '.text-fg-muted',
      '.border-border',
      '.rounded-md',
      '.grid-cols-1',
    ]) {
      assert.ok(res.text.includes(utility), `missing ${utility} in plugin-ui.css`);
    }
  });

  it('keeps the legacy admin-ui.css alias resolving to the same bytes', async () => {
    const generated = await invoke(app, 'GET', '/api/_harness/plugin-ui.css');
    const alias = await invoke(app, 'GET', '/api/_harness/admin-ui.css');
    assert.equal(alias.status, 200);
    assert.equal(alias.text, generated.text);
  });

  it('still carries the .harness-* helpers shipped plugin admin UIs use', async () => {
    const res = await invoke(app, 'GET', '/api/_harness/admin-ui.css');
    for (const cls of ['.harness-admin', '.harness-btn', '.harness-banner-error']) {
      assert.ok(res.text.includes(cls), `missing ${cls} — would restyle shipped plugins`);
    }
  });
});

describe('plugin UI proof — what the contract forbids', () => {
  let packagesDir: string;

  before(async () => {
    packagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-ui-proof-neg-'));
  });

  after(async () => {
    await fs.rm(packagesDir, { recursive: true, force: true });
  });

  it('rejects a .css file inside ui/ — the inability to ship CSS IS the rule', async () => {
    const files = await fixtureFiles();
    files['ui/assets/theme.css'] = 'body { color: #ff00ff }';
    const result = await service(packagesDir).ingest({
      fileBuffer: await buildZip(files),
      originalFilename: 'css.zip',
      uploadedBy: 'test',
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.code, 'zip.forbidden_extension');
    assert.match(result.message, /theme\.css/);
  });

  it('rejects an arbitrary Tailwind value in the bundle, naming the offender', async () => {
    const files = await fixtureFiles();
    files['ui/assets/app-7c1f4b2e.js'] =
      `${appJs}\nconst BAD = "flex w-[137px] bg-[#abc]";\nexport { BAD };\n`;
    const result = await service(packagesDir).ingest({
      fileBuffer: await buildZip(files),
      originalFilename: 'arbitrary.zip',
      uploadedBy: 'test',
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.code, 'package.ui_arbitrary_tailwind_value');
    assert.match(result.message, /w-\[137px\]/);
    assert.match(result.message, /plugin-ui-vocabulary\.md/);
  });

  it('accepts a .woff2 inside ui/ but not outside it', async () => {
    const withFont = await fixtureFiles();
    withFont['ui/assets/inter.woff2'] = 'not-a-real-font';
    const ok = await service(packagesDir).ingest({
      fileBuffer: await buildZip(withFont),
      originalFilename: 'font-ok.zip',
      uploadedBy: 'test',
    });
    assert.equal(ok.ok, true, ok.ok ? '' : `${ok.code}: ${ok.message}`);

    const outside = await fixtureFiles();
    outside['fonts/inter.woff2'] = 'not-a-real-font';
    const bad = await service(packagesDir).ingest({
      fileBuffer: await buildZip(outside),
      originalFilename: 'font-bad.zip',
      uploadedBy: 'test',
    });
    assert.equal(bad.ok, false);
    assert.ok(!bad.ok);
    assert.equal(bad.code, 'zip.forbidden_extension');
  });
});
