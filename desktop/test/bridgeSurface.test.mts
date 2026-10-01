/**
 * Which slice of the renderer bridge a document gets.
 *
 * The shell shows every page in one window with one preload: the bundled
 * first-run wizard and loading screen, the loopback web UI after boot, and
 * whatever a server redirect lands the window on. The preload used to expose
 * the full setup bridge — the recovery-key export and the setup `complete`
 * included — to every one of them, so the web UI, and any same-origin plugin
 * iframe in it through `window.parent.omadia`, could read the vault master key.
 *
 * These pin the classification, what the preload really exposes per surface,
 * and that the preload bundle stays loadable in the sandbox. Main's sender
 * check (`ipcSender.test.mts`) is the boundary; this is the defence in depth
 * in front of it.
 */
import { describe, it, beforeEach, after } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { __setContextBridge } from './helpers/electron-fake.mjs';
import { bridgeSurfaceFor, LOADING_PAGE, WIZARD_PAGE } from '../src/bridgeSurface.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

/** A packaged macOS install: the pages sit inside the asar archive. */
const PACKAGED_RENDERER = path.join(
  '/Applications',
  'omadia.app',
  'Contents',
  'Resources',
  'app.asar',
  'dist',
  'renderer',
);

function bundled(page: string, dir = PACKAGED_RENDERER): string {
  return pathToFileURL(path.join(dir, page)).href;
}

describe('bridgeSurfaceFor', () => {
  it('gives the bundled wizard the wizard surface, whatever its query and hash', () => {
    assert.equal(bridgeSurfaceFor(bundled(WIZARD_PAGE)), 'wizard');
    assert.equal(bridgeSurfaceFor(`${bundled(WIZARD_PAGE)}?log=/tmp/omadia.log#recovered`), 'wizard');
  });

  it('matches the wizard under a path with spaces and on a Windows drive', () => {
    const spaced = bundled(WIZARD_PAGE, path.join('/Users', 'Jane Doe', 'omadia dev', 'dist', 'renderer'));
    assert.match(spaced, /%20/, 'the fixture must carry percent-encoding');
    assert.equal(bridgeSurfaceFor(spaced), 'wizard');
    assert.equal(
      bridgeSurfaceFor(
        'file:///C:/Program%20Files/omadia/resources/app.asar/dist/renderer/wizard.html?log=C%3A%5Clog',
      ),
      'wizard',
    );
  });

  it('gives the loading screen the boot surface', () => {
    assert.equal(bridgeSurfaceFor(`${bundled(LOADING_PAGE)}?log=/tmp/omadia.log`), 'boot');
  });

  it('gives the loopback web UI the app surface', () => {
    assert.equal(bridgeSurfaceFor('http://127.0.0.1:4567/chat'), 'app');
    assert.equal(bridgeSurfaceFor('http://127.0.0.1:4567/'), 'app');
  });

  it('gives every other document no bridge at all', () => {
    const foreign = [
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=synthetic',
      'http://localhost:4567/',
      'https://127.0.0.1:4567/',
      'http://127.0.0.1.evil.example/',
      'http://127.0.0.1@evil.example/',
      'http://[::1]:4567/',
      'about:blank',
      'data:text/html,<p>synthetic</p>',
      'javascript:alert(1)',
      'blob:http://127.0.0.1:4567/5d9c7c2e-0000-4000-8000-000000000000',
      pathToFileURL('/Users/x/Documents/notes.html').href,
      `${bundled('wizard.js')}`,
      '',
      'not a url',
    ];
    for (const href of foreign) {
      assert.equal(bridgeSurfaceFor(href), 'none', href);
    }
  });

  it('classifies a wizard.html elsewhere on disk by its name only: main is the gate', () => {
    // The sandboxed preload has no Node and cannot compare install paths, so a
    // lookalike still gets the wizard surface HERE. ipcSender.ts refuses it,
    // which is why that check exists (see ipcSender.test.mts).
    assert.equal(bridgeSurfaceFor(pathToFileURL('/Users/x/Downloads/wizard.html').href), 'wizard');
  });
});

/**
 * The preload itself, run against a recording `contextBridge`. Each load is a
 * fresh module instance (the query busts the ESM cache), with `window.location`
 * set to the document under test, exactly as the preload sees it before any
 * page script runs.
 */
describe('preload — each document gets only its own surface', () => {
  let exposed: Array<{ readonly key: string; readonly api: Record<string, unknown> }> = [];
  let loads = 0;

  beforeEach(() => {
    exposed = [];
    __setContextBridge({
      exposeInMainWorld: (key, api) => {
        exposed.push({ key, api: api as Record<string, unknown> });
      },
    });
  });

  after(() => {
    __setContextBridge(null);
    delete (globalThis as { window?: unknown }).window;
  });

  async function exposedFor(href: string): Promise<typeof exposed> {
    (globalThis as { window?: unknown }).window = { location: { href } };
    loads += 1;
    await import(`../src/preload.ts?load=${loads}`);
    return exposed;
  }

  it('gives the web UI uiReady and setUiLocale, and nothing that returns or writes a secret', async () => {
    const calls = await exposedFor('http://127.0.0.1:4567/chat');
    assert.equal(calls.length, 1);
    const [bridge] = calls;
    assert.equal(bridge?.key, 'omadia');
    assert.deepEqual(Object.keys(bridge?.api ?? {}).sort(), ['setUiLocale', 'uiReady']);
    assert.equal('exportRecoveryKey' in (bridge?.api ?? {}), false);
    assert.equal('complete' in (bridge?.api ?? {}), false);
  });

  it('gives the wizard its setup methods and the boot stream', async () => {
    const calls = await exposedFor(`${bundled(WIZARD_PAGE)}?log=/tmp/omadia.log`);
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]?.api ?? {}).sort(), [
      'chooseDataDir',
      'complete',
      'exportRecoveryKey',
      'onBootLog',
      'onBootProgress',
      'testLlmKey',
    ]);
  });

  it('gives the loading screen the boot stream only', async () => {
    const calls = await exposedFor(`${bundled(LOADING_PAGE)}?log=/tmp/omadia.log`);
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]?.api ?? {}).sort(), ['onBootLog', 'onBootProgress']);
  });

  it('exposes nothing to a foreign document, such as an IdP page reached by a redirect', async () => {
    assert.deepEqual(await exposedFor('https://login.microsoftonline.com/common/login'), []);
    assert.deepEqual(await exposedFor('about:blank'), []);
  });
});

describe('preload bundle stays loadable in the sandbox', () => {
  it('bridgeSurface.ts imports nothing, because it is inlined into the sandboxed preload', () => {
    const code = fs
      .readFileSync(path.join(SRC, 'bridgeSurface.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /^\s*import\b/m);
    assert.doesNotMatch(code, /\bimport\s*\(/);
    assert.doesNotMatch(code, /\brequire\s*\(/);
  });

  it('the bundled preload requires nothing but electron', async () => {
    // Same shape as scripts/bundle-preload.mjs. A sandboxed preload can only
    // `require('electron')`; anything else fails to load and freezes the wizard.
    const result = await build({
      entryPoints: [path.join(SRC, 'preload.ts')],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      logLevel: 'silent',
    });
    const code = result.outputFiles[0]?.text ?? '';
    const required = new Set([...code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));
    assert.deepEqual([...required], ['electron']);
  });
});
