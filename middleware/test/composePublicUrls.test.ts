/**
 * Issue #1317 — the docker-compose stack never set `PUBLIC_BASE_URL`, so the
 * middleware built browser URLs on its own default `http://localhost:3979`,
 * where nothing listens in that stack. The login redirect landed on a
 * connection error.
 *
 * The stack now loads `middleware/compose.defaults.env` ahead of
 * `middleware/.env`. This suite checks the compose file itself: the defaults
 * file is loaded first (so an operator's `middleware/.env` wins), none of its
 * keys is pinned under `environment:` (which would beat both files), and every
 * URL in it points at a port the stack actually publishes for that service.
 *
 * Compose's own merge of the env files is checked in CI by
 * `docker compose … config --quiet`; this is the regression net for the layout.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULTS_FILE = 'middleware/compose.defaults.env';
const OPERATOR_FILE = 'middleware/.env';

interface ComposeService {
  env_file?: ReadonlyArray<string | { path: string; required?: boolean }>;
  environment?: Record<string, unknown>;
  ports?: readonly string[];
}

function loadServices(): Record<string, ComposeService> {
  const doc = parse(readFileSync(path.join(REPO_ROOT, 'docker-compose.yaml'), 'utf8')) as {
    services: Record<string, ComposeService>;
  };
  return doc.services;
}

function loadDefaults(): Map<string, string> {
  const text = readFileSync(path.join(REPO_ROOT, DEFAULTS_FILE), 'utf8');
  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line): [string, string] => {
      const eq = line.indexOf('=');
      return [line.slice(0, eq), line.slice(eq + 1)];
    });
  return new Map(entries);
}

/** The host port a service publishes, from `'127.0.0.1:<host>:<container>'`. */
function hostPort(service: ComposeService): string {
  const mapping = service.ports?.[0];
  assert.ok(mapping, 'service publishes no port');
  const parts = mapping.split(':');
  return parts[parts.length - 2] ?? '';
}

describe('#1317 — compose stack sets the public URLs', () => {
  const services = loadServices();
  const middleware = services['middleware'];
  const webUi = services['web-ui'];
  assert.ok(middleware && webUi);
  const defaults = loadDefaults();

  it('loads the defaults file before middleware/.env', () => {
    const paths = (middleware.env_file ?? []).map((e) => (typeof e === 'string' ? e : e.path));
    const defaultsAt = paths.indexOf(DEFAULTS_FILE);
    const operatorAt = paths.indexOf(OPERATOR_FILE);
    assert.ok(defaultsAt >= 0, `${DEFAULTS_FILE} is not in env_file`);
    assert.ok(operatorAt > defaultsAt, `${OPERATOR_FILE} must come after ${DEFAULTS_FILE}`);
  });

  it('pins none of the defaults under environment:', () => {
    const pinned = Object.keys(middleware.environment ?? {}).filter((k) => defaults.has(k));
    assert.deepEqual(pinned, []);
  });

  it('points browser-facing URLs at the published web-ui port', () => {
    const uiOrigin = `http://localhost:${hostPort(webUi)}`;
    assert.equal(defaults.get('PUBLIC_BASE_URL'), uiOrigin);
    // The UI proxies only /bot-api/* to the middleware, never raw /api/*.
    for (const key of ['AUTH_REDIRECT_URI', 'MCP_OAUTH_REDIRECT_URI']) {
      const value = defaults.get(key);
      assert.ok(value?.startsWith(`${uiOrigin}/bot-api/`), `${key}=${String(value)}`);
    }
  });

  it('points the webhook base at the published middleware port', () => {
    assert.equal(
      defaults.get('CONDUCTOR_WEBHOOK_PUBLIC_BASE_URL'),
      `http://localhost:${hostPort(middleware)}`,
    );
  });

  it('never falls back to the from-source port 3979', () => {
    for (const [key, value] of defaults) {
      assert.ok(!value.includes(':3979'), `${key}=${value}`);
    }
  });
});
