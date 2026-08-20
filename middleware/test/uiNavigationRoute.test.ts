import { before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import express, { type Express } from 'express';

import { UiRouteCatalog } from '../src/platform/uiRouteCatalog.js';
import {
  createUiNavigationRouter,
  resolveRequestLocale,
} from '../src/routes/uiNavigation.js';
import { getJson, invoke } from './_helpers/httpInvoke.js';

/**
 * `GET /api/v1/ui/navigation` — the shell's dynamic nav source
 * (epic #470).
 *
 * Driven through `app.handle` rather than a listening socket: the suite runs
 * files concurrently and port-holding tests make unrelated socket tests flaky
 * under contention. Route matching and `res.json` still run for real.
 */

interface NavBody {
  locale: string;
  entries: { pluginId: string; navId: string; label: string; href: string; order: number }[];
}

describe('resolveRequestLocale', () => {
  const supported = ['en', 'de'] as const;

  it('accepts a supported locale', () => {
    assert.equal(resolveRequestLocale('de', supported, 'en'), 'de');
  });

  it('narrows a regional locale to its supported base language', () => {
    assert.equal(resolveRequestLocale('de-AT', supported, 'en'), 'de');
  });

  it('falls back for an unsupported locale', () => {
    assert.equal(resolveRequestLocale('fr', supported, 'en'), 'en');
  });

  it('falls back for a missing locale', () => {
    assert.equal(resolveRequestLocale(undefined, supported, 'en'), 'en');
  });

  it('falls back for a non-string (express gives arrays for repeated params)', () => {
    assert.equal(resolveRequestLocale(['de', 'en'], supported, 'en'), 'en');
  });

  it('does not echo an unvalidated value back into label resolution', () => {
    assert.equal(resolveRequestLocale('../../etc/passwd', supported, 'en'), 'en');
  });
});

describe('GET /api/v1/ui/navigation', () => {
  const catalog = new UiRouteCatalog();
  let app: Express;

  before(() => {
    catalog.registerNav('core:example-plugin', {
      navId: 'examplePlugin',
      href: '/admin/example-plugin',
      cluster: 'adminCluster',
      order: 50,
      label: { en: 'Example Plugin', de: 'Beispiel-Plugin' },
    });
    catalog.registerNav('@plugin/reports', {
      navId: 'reports',
      href: '/reports',
      label: { en: 'Reports' },
    });

    app = express();
    app.use(
      '/api',
      createUiNavigationRouter({
        catalog,
        supportedLocales: ['en', 'de'],
        defaultLocale: 'en',
      }),
    );
  });

  it('returns entries with labels resolved for the default locale', async () => {
    const { status, body } = await getJson<NavBody>(app, '/api/v1/ui/navigation');
    assert.equal(status, 200);
    assert.equal(body.locale, 'en');
    assert.deepEqual(
      body.entries.map((e) => [e.navId, e.label]),
      [
        ['examplePlugin', 'Example Plugin'],
        ['reports', 'Reports'],
      ],
      'sorted by order (50 before default 100), labels resolved',
    );
  });

  it('resolves labels for the requested locale', async () => {
    const { body } = await getJson<NavBody>(app, '/api/v1/ui/navigation?locale=de');
    assert.equal(body.locale, 'de');
    assert.equal(
      body.entries.find((e) => e.navId === 'examplePlugin')?.label,
      'Beispiel-Plugin',
    );
    assert.equal(
      body.entries.find((e) => e.navId === 'reports')?.label,
      'Reports',
      'untranslated entry falls back to en',
    );
  });

  it('never leaks the per-locale label map to the browser', async () => {
    const res = await invoke(app, 'GET', '/api/v1/ui/navigation');
    assert.equal(
      res.text.includes('Beispiel-Plugin'),
      false,
      'the de label must not ship in an en response',
    );
  });

  it('is not cacheable — it varies by locale and by installed plugins', async () => {
    const res = await invoke(app, 'GET', '/api/v1/ui/navigation');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('reflects deactivation live — a disposed source disappears from the response', async () => {
    // Against the same app, so this also proves the router reads the
    // catalogue per request rather than snapshotting it at mount.
    const navIds = async (): Promise<string[]> =>
      (await getJson<NavBody>(app, '/api/v1/ui/navigation')).body.entries.map(
        (e) => e.navId,
      );

    catalog.registerNav('@plugin/temp', {
      navId: 'temp',
      href: '/temp',
      label: { en: 'Temp' },
    });
    assert.equal((await navIds()).includes('temp'), true, 'precondition');

    catalog.disposeBySource('@plugin/temp');

    const remaining = await navIds();
    assert.equal(
      remaining.includes('temp'),
      false,
      'uninstalling a plugin removes its menu entry with no frontend rebuild',
    );
    assert.equal(remaining.length, 2, 'the other plugins are untouched');
  });
});
