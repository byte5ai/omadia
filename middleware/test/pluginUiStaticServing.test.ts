/**
 * Static serving of a plugin's compiled SPA bundle (epic #470 C8 / G7).
 *
 * `/p/<pluginId>/ui/...` is reachable without an operator session — the
 * `publicPaths` allowlist has covered `/p/*` since plugin UI surfaces were
 * first iframed by Teams. That makes every property below load-bearing rather
 * than defence in depth: this handler is the boundary.
 *
 * Driven through `app.handle` (see `_helpers/httpInvoke.ts`) so routing,
 * params and headers run for real without holding a port.
 */

import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express, { type Express } from 'express';

import {
  CONTENT_TYPES,
  createPluginUiStaticRouter,
  safeRelativePath,
} from '../src/routes/pluginUiStatic.js';
import { invoke } from './_helpers/httpInvoke.js';

const PLUGIN_ID = 'proof-plugin';
const CONTENT_TYPE_FIXTURE_PREFIX = 'content-type-probe';

let root: string;
let packageRoot: string;
let app: Express;

function fixtureBodyForExtension(ext: string): string | Uint8Array {
  switch (ext) {
    case '.html':
      return '<!doctype html><title>probe</title><p>probe</p>';
    case '.js':
    case '.mjs':
      return 'export const probe = true;';
    case '.map':
      return '{"version":3,"file":"probe.js","sources":[],"names":[],"mappings":""}';
    case '.json':
      return '{"probe":true}';
    case '.svg':
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
    case '.png':
      return Buffer.from('png-probe');
    case '.jpg':
    case '.jpeg':
      return Buffer.from('jpeg-probe');
    case '.woff2':
      return Buffer.from('woff2-probe');
    case '.txt':
      return 'probe';
    default:
      throw new Error(`Unhandled fixture extension: ${ext}`);
  }
}

function fixtureRequestPath(ext: string): string {
  return `/p/${PLUGIN_ID}/ui/assets/${CONTENT_TYPE_FIXTURE_PREFIX}${ext}`;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-ui-static-'));
  packageRoot = path.join(root, 'packages', PLUGIN_ID, '1.0.0');
  const ui = path.join(packageRoot, 'ui');
  await fs.mkdir(path.join(ui, 'assets'), { recursive: true });
  await fs.mkdir(path.join(ui, 'empty-dir'), { recursive: true });
  await fs.writeFile(path.join(ui, 'index.html'), '<!doctype html><p class="p-4">hi</p>');
  await fs.writeFile(path.join(ui, 'assets', 'app-7c1f4b2e.js'), 'export const x = 1;');
  await fs.writeFile(path.join(ui, 'assets', 'main-B2kf9Xz1.js'), 'export const z = 3;');
  await fs.writeFile(path.join(ui, 'assets', 'app.js'), 'export const y = 2;');
  await fs.writeFile(path.join(ui, 'assets', 'app-bootstrap.js'), 'export const boot = true;');
  await fs.writeFile(path.join(ui, 'assets', 'vendor-polyfills.js'), 'export const polyfills = true;');
  await fs.writeFile(path.join(ui, 'assets', 'logo.svg'), '<svg/>');
  await fs.writeFile(path.join(ui, 'assets', 'notes.css'), 'body{color:red}');
  for (const [ext] of CONTENT_TYPES) {
    await fs.writeFile(
      path.join(ui, 'assets', `${CONTENT_TYPE_FIXTURE_PREFIX}${ext}`),
      fixtureBodyForExtension(ext),
    );
  }
  // A secret NEXT to the bundle: the thing traversal would be aiming at.
  await fs.writeFile(path.join(packageRoot, 'manifest.yaml'), 'schema_version: "1"\n');

  app = express();
  app.use(
    '/p',
    createPluginUiStaticRouter({
      resolvePackageRoot: (id) => (id === PLUGIN_ID ? packageRoot : undefined),
    }),
  );
  // Anything the static router passes through must be visibly distinct from
  // what it answers, or "falls through" would be untestable.
  app.use('/p', (_req, res) => {
    res.status(418).json({ error: 'fell_through' });
  });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('plugin UI static serving — happy path', () => {
  it('serves index.html at the bundle root', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(res.text, /doctype html/);
  });

  it('serves index.html at the bundle root without a trailing slash', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  });

  it('serves a nested hashed asset with a JS content-type', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/app-7c1f4b2e.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(res.text, 'export const x = 1;');
  });

  it('serves svg with its own type, never sniffed', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/logo.svg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/svg+xml');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('passes non-ui paths through to the plugin router', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/webhook`);
    assert.equal(res.status, 418);
  });

  it('404s an unknown plugin id', async () => {
    const res = await invoke(app, 'GET', '/p/not-installed/ui/index.html');
    assert.equal(res.status, 404);
  });
});

describe('plugin UI static serving — caching', () => {
  it('marks a hash-named file immutable for a year', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/app-7c1f4b2e.js`);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  it('does NOT mark an unhashed file immutable — an upgrade must be visible', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/app.js`);
    assert.equal(res.headers['cache-control'], 'no-cache');
  });

  it('does NOT freeze app-bootstrap.js for a year — the trailing word is not a hash', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/app-bootstrap.js`);
    assert.equal(res.headers['cache-control'], 'no-cache');
  });

  it('does NOT freeze vendor-polyfills.js for a year — ordinary bundle names must revalidate', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/vendor-polyfills.js`);
    assert.equal(res.headers['cache-control'], 'no-cache');
  });

  it('never marks index.html immutable', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/index.html`);
    assert.equal(res.headers['cache-control'], 'no-cache');
  });

  it('keeps a hex-style content hash immutable', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/app-7c1f4b2e.js`);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  it('keeps a base36-style content hash immutable', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/main-B2kf9Xz1.js`);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  it('answers 304 for a matching ETag', async () => {
    const first = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/index.html`);
    const etag = first.headers['etag'];
    assert.ok(typeof etag === 'string' && etag.length > 2);
    const second = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/index.html`, {
      headers: { 'if-none-match': etag },
    });
    assert.equal(second.status, 304);
  });
});

describe('plugin UI static serving — the security boundary', () => {
  it('refuses a traversal out of the bundle', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/../manifest.yaml`);
    assert.notEqual(res.status, 200);
    assert.ok(!res.text.includes('schema_version'));
  });

  it('refuses a percent-encoded traversal', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/%2e%2e/manifest.yaml`);
    assert.notEqual(res.status, 200);
    assert.ok(!res.text.includes('schema_version'));
  });

  it('refuses a double-encoded traversal', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/%252e%252e/manifest.yaml`);
    assert.notEqual(res.status, 200);
    assert.ok(!res.text.includes('schema_version'));
  });

  it('refuses a deep traversal aimed at the host filesystem', async () => {
    const res = await invoke(
      app,
      'GET',
      `/p/${PLUGIN_ID}/ui/../../../../../../etc/passwd`,
    );
    assert.notEqual(res.status, 200);
    assert.ok(!res.text.includes('root:'));
  });

  it('refuses backslash separators', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/..%5Cmanifest.yaml`);
    assert.notEqual(res.status, 200);
  });

  it('never serves a directory, and never lists one', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets`);
    assert.equal(res.status, 404);
    assert.ok(!res.text.includes('app-7c1f4b2e.js'));
  });

  it('never lists an empty directory either', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/empty-dir/`);
    assert.equal(res.status, 404);
  });

  it('refuses .css even when the file is physically present', async () => {
    // Belt and braces: the extractor already rejects `.css`, but if a bundle
    // ever carried one, serving it would end "plugins inherit the design
    // system by construction" on the spot.
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/notes.css`);
    assert.equal(res.status, 404);
    assert.ok(!res.text.includes('color:red'));
  });

  it('sets a confining CSP on the HTML document', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/index.html`);
    const csp = String(res.headers['content-security-policy'] ?? '');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /base-uri 'none'/);
    assert.ok(!csp.includes("script-src 'unsafe-inline'"));
  });

  it('sets a sandboxing CSP on SVG so direct navigation cannot execute in origin', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/logo.svg`);
    const csp = String(res.headers['content-security-policy'] ?? '');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /\bsandbox\b/);
  });

  it('also sends CSP on JS assets so the handler cannot regress by branch omission', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/assets/app-7c1f4b2e.js`);
    const csp = String(res.headers['content-security-policy'] ?? '');
    assert.match(csp, /default-src 'none'/);
  });

  it('does not leak the referrer to plugin-side navigations', async () => {
    const res = await invoke(app, 'GET', `/p/${PLUGIN_ID}/ui/index.html`);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  });
});

describe('plugin UI static serving — CONTENT_TYPES coverage', () => {
  for (const [ext, contentType] of CONTENT_TYPES) {
    it(`serves ${ext} with the mapped Content-Type, nosniff and the expected CSP`, async () => {
      const res = await invoke(app, 'GET', fixtureRequestPath(ext));
      assert.equal(
        res.status,
        200,
        `pluginUiStatic.ts should serve ${ext} fixtures from CONTENT_TYPES; revisit middleware/src/routes/pluginUiStatic.ts if ${ext} stopped resolving`,
      );
      assert.equal(
        res.headers['content-type'],
        contentType,
        `pluginUiStatic.ts no longer serves ${ext} with the CONTENT_TYPES mapping exported from middleware/src/routes/pluginUiStatic.ts`,
      );
      assert.equal(
        res.headers['x-content-type-options'],
        'nosniff',
        `pluginUiStatic.ts must keep nosniff on ${ext}; revisit middleware/src/routes/pluginUiStatic.ts if that header regressed`,
      );

      const csp = String(res.headers['content-security-policy'] ?? '');
      assert.ok(
        csp.length > 0,
        `pluginUiStatic.ts stopped sending Content-Security-Policy on ${ext}; revisit the serve() tail in middleware/src/routes/pluginUiStatic.ts`,
      );
      if (ext === '.svg') {
        assert.match(
          csp,
          /default-src 'none'/,
          'pluginUiStatic.ts must keep the SVG-specific confinement policy on .svg assets; revisit middleware/src/routes/pluginUiStatic.ts if that branch changed',
        );
        assert.match(
          csp,
          /\bsandbox\b/,
          'pluginUiStatic.ts must keep the SVG sandbox directive on .svg assets; revisit middleware/src/routes/pluginUiStatic.ts if that branch changed',
        );
      } else {
        assert.match(
          csp,
          /script-src 'self'/,
          `pluginUiStatic.ts must keep the standard CSP on ${ext}; revisit middleware/src/routes/pluginUiStatic.ts if non-SVG assets lost script-src 'self'`,
        );
        assert.match(
          csp,
          /frame-ancestors 'self'/,
          `pluginUiStatic.ts must keep the standard CSP on ${ext}; revisit middleware/src/routes/pluginUiStatic.ts if non-SVG assets lost frame-ancestors 'self'`,
        );
        assert.ok(
          !/\bsandbox\b/.test(csp),
          `pluginUiStatic.ts should not send the SVG sandbox directive on ${ext}; revisit middleware/src/routes/pluginUiStatic.ts if the CSP branches collapsed`,
        );
      }
    });
  }

  it('keeps CSP and nosniff on the 304 revalidation branch', async () => {
    const first = await invoke(app, 'GET', fixtureRequestPath('.json'));
    const etag = first.headers['etag'];
    assert.ok(
      typeof etag === 'string' && etag.length > 2,
      'pluginUiStatic.ts should emit an ETag before the 304 branch can be exercised; revisit middleware/src/routes/pluginUiStatic.ts if revalidation changed',
    );

    const second = await invoke(app, 'GET', fixtureRequestPath('.json'), {
      headers: { 'if-none-match': etag },
    });
    assert.equal(second.status, 304);
    assert.equal(
      second.headers['x-content-type-options'],
      'nosniff',
      'pluginUiStatic.ts must keep X-Content-Type-Options on 304 responses; revisit the serve() tail in middleware/src/routes/pluginUiStatic.ts if the branch moved ahead of header-setting',
    );
    const csp = String(second.headers['content-security-policy'] ?? '');
    assert.ok(
      csp.length > 0,
      'pluginUiStatic.ts must keep Content-Security-Policy on 304 responses; revisit the serve() tail in middleware/src/routes/pluginUiStatic.ts if the branch moved ahead of header-setting',
    );
    assert.match(
      csp,
      /script-src 'self'/,
      'pluginUiStatic.ts must keep the standard CSP on 304 responses for non-SVG assets; revisit middleware/src/routes/pluginUiStatic.ts if the response lost it',
    );
  });
});

describe('safeRelativePath', () => {
  const rejected = [
    '../secrets',
    'a/../../b',
    '%2e%2e/x',
    '/etc/passwd',
    'a\\..\\b',
    'a\0b',
  ];
  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.equal(safeRelativePath(input), null);
    });
  }

  it('normalises redundant segments without allowing escape', () => {
    assert.equal(safeRelativePath('a/./b//c.js'), 'a/b/c.js');
  });

  it('accepts an ordinary nested asset path', () => {
    assert.equal(safeRelativePath('assets/app-7c1f4b2e.js'), 'assets/app-7c1f4b2e.js');
  });

  it('rejects a malformed percent escape rather than guessing', () => {
    assert.equal(safeRelativePath('%zz'), null);
  });
});
