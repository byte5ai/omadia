import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import { UiRouteCatalog } from '../src/platform/uiRouteCatalog.js';
import {
  createUiNavigationRouter,
  resolveRequestLocale,
} from '../src/routes/uiNavigation.js';

/**
 * `GET /api/v1/ui/navigation` — the shell's dynamic nav source
 * (specs/470-dev-platform-plugin).
 */

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
    assert.equal(
      resolveRequestLocale('../../etc/passwd', supported, 'en'),
      'en',
    );
  });
});

describe('GET /api/v1/ui/navigation', () => {
  const catalog = new UiRouteCatalog();
  let server: Server;
  let base: string;

  before(async () => {
    catalog.registerNav('core:dev-platform', {
      navId: 'devPlatform',
      href: '/admin/dev-platform',
      cluster: 'adminCluster',
      order: 50,
      label: { en: 'Dev Platform', de: 'Dev-Plattform' },
    });
    catalog.registerNav('@plugin/reports', {
      navId: 'reports',
      href: '/reports',
      label: { en: 'Reports' },
    });

    const app = express();
    app.use(
      '/api',
      createUiNavigationRouter({
        catalog,
        supportedLocales: ['en', 'de'],
        defaultLocale: 'en',
      }),
    );
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('returns entries with labels resolved for the default locale', async () => {
    const res = await fetch(`${base}/api/v1/ui/navigation`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      locale: string;
      entries: { navId: string; label: string; href: string; order: number }[];
    };
    assert.equal(body.locale, 'en');
    assert.deepEqual(
      body.entries.map((e) => [e.navId, e.label]),
      [
        ['devPlatform', 'Dev Platform'],
        ['reports', 'Reports'],
      ],
      'sorted by order (50 before default 100), labels resolved',
    );
  });

  it('resolves labels for the requested locale', async () => {
    const res = await fetch(`${base}/api/v1/ui/navigation?locale=de`);
    const body = (await res.json()) as {
      locale: string;
      entries: { navId: string; label: string }[];
    };
    assert.equal(body.locale, 'de');
    const dev = body.entries.find((e) => e.navId === 'devPlatform');
    assert.equal(dev?.label, 'Dev-Plattform');
    const reports = body.entries.find((e) => e.navId === 'reports');
    assert.equal(reports?.label, 'Reports', 'untranslated entry falls back to en');
  });

  it('never leaks the per-locale label map to the browser', async () => {
    const res = await fetch(`${base}/api/v1/ui/navigation`);
    const raw = await res.text();
    assert.equal(
      raw.includes('Dev-Plattform'),
      false,
      'the de label must not ship in an en response',
    );
  });

  it('is not cacheable — it varies by locale and by installed plugins', async () => {
    const res = await fetch(`${base}/api/v1/ui/navigation`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('reflects deactivation — a disposed source disappears from the response', async () => {
    const scratch = new UiRouteCatalog();
    scratch.registerNav('@plugin/temp', {
      navId: 'temp',
      href: '/temp',
      label: { en: 'Temp' },
    });
    const app = express();
    app.use(
      '/api',
      createUiNavigationRouter({
        catalog: scratch,
        supportedLocales: ['en'],
        defaultLocale: 'en',
      }),
    );
    const srv = app.listen(0);
    await new Promise((resolve) => srv.once('listening', resolve));
    const at = `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}`;

    try {
      const before = (await (await fetch(`${at}/api/v1/ui/navigation`)).json()) as {
        entries: unknown[];
      };
      assert.equal(before.entries.length, 1);

      scratch.disposeBySource('@plugin/temp');

      const afterDispose = (await (
        await fetch(`${at}/api/v1/ui/navigation`)
      ).json()) as { entries: unknown[] };
      assert.deepEqual(
        afterDispose.entries,
        [],
        'uninstalling a plugin removes its menu entry with no frontend rebuild',
      );
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
});
