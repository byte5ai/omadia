import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPlatformChecks } from '../src/health/platformHealth.js';

/**
 * #1385 — the flat `checks` block on `/health`. It is the one unauthenticated
 * place that can still name the database as the problem while every
 * authenticated route answers 503 `auth.unavailable` (#1384).
 */


describe('buildPlatformChecks — database', () => {
  it('reports ok when the shared pool answered', () => {
    const checks = buildPlatformChecks({
      kg: { backend: 'neon', pool: 'live' },
      databaseConfigured: true,
    });
    assert.equal(checks.database, 'ok');
  });

  it('reports unreachable when the pool is dead (the #1384 outage)', () => {
    const checks = buildPlatformChecks({
      kg: { backend: 'neon', pool: 'dead' },
      databaseConfigured: true,
    });
    assert.equal(checks.database, 'unreachable');
  });

  it('does not claim a configured database is fine when no pool exists to ask', () => {
    const checks = buildPlatformChecks({
      kg: { backend: 'none', pool: 'skipped' },
      databaseConfigured: true,
    });
    assert.equal(checks.database, 'unknown');
  });

  it('reports none on the in-memory backend without DATABASE_URL — not a fault', () => {
    const checks = buildPlatformChecks({
      kg: { backend: 'inmemory', pool: 'skipped' },
      databaseConfigured: false,
    });
    assert.equal(checks.database, 'none');
  });
});

describe('buildPlatformChecks — no key posture on the public endpoint', () => {
  it('reports the database only', () => {
    const checks = buildPlatformChecks({
      kg: { backend: 'neon', pool: 'live' },
      databaseConfigured: true,
    });
    assert.deepEqual(Object.keys(checks), ['database']);
  });
});

describe('/health wiring — checks are additive', () => {
  // Importing index.ts boots the whole middleware, so the wiring is read from
  // source, like coreMigrationsBootWiring.test.ts does.
  const here = dirname(fileURLToPath(import.meta.url));
  const indexPath = resolve(here, '..', 'src', 'index.ts');

  it('/health returns the checks block next to kg', async () => {
    const src = await readFile(indexPath, 'utf8');
    const route = src.slice(src.indexOf("app.get('/health'"));
    const body = route.slice(0, route.indexOf('})();'));
    assert.match(body, /buildPlatformChecks\(/);
    assert.match(body, /\n\s+checks,\n\s+kg,/);
  });

  it('keeps the status and HTTP code semantics the updater and desktop key on', async () => {
    const src = await readFile(indexPath, 'utf8');
    const route = src.slice(src.indexOf("app.get('/health'"));
    const body = route.slice(0, route.indexOf('})();'));
    assert.match(body, /const status = kg\.pool === 'dead' \? 'error' : 'ok';/);
    assert.match(body, /\.status\(kg\.pool === 'dead' \? 503 : 200\)/);
  });

  it('does not publish master-key posture on the public endpoint', async () => {
    const src = await readFile(indexPath, 'utf8');
    const route = src.slice(src.indexOf("app.get('/health'"));
    const body = route.slice(0, route.indexOf('})();'));
    assert.doesNotMatch(body, /masterKey|credentialMasterKey/);
  });
});
