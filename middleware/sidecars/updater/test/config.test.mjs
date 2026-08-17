import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { isValidTargetVersion, loadConfig, PROTECTED_SERVICES } from '../src/config.mjs';

const VALID_TOKEN = 'x'.repeat(32);

describe('updater config (#432)', () => {
  it('refuses to start without a token', () => {
    assert.throws(() => loadConfig({}), /UPDATER_TOKEN is required/);
  });

  it('refuses a token short enough to guess', () => {
    assert.throws(
      () => loadConfig({ UPDATER_TOKEN: 'short' }),
      /at least 16 characters/,
    );
  });

  it('refuses to manage postgres, itself, or the socket proxy', () => {
    for (const service of PROTECTED_SERVICES) {
      assert.throws(
        () =>
          loadConfig({
            UPDATER_TOKEN: VALID_TOKEN,
            UPDATER_SERVICES: `middleware,${service}`,
          }),
        new RegExp(`protected service "${service}"`),
      );
    }
  });

  it('defaults to the two application services', () => {
    const config = loadConfig({ UPDATER_TOKEN: VALID_TOKEN });
    assert.deepEqual(config.services, ['middleware', 'web-ui']);
    assert.equal(config.envFilePath, '/workspace/.env');
    assert.equal(config.healthUrl, 'http://middleware:8080/health');
    assert.equal(config.dockerApiUrl, 'http://docker-socket-proxy:2375');
  });

  it('rejects an empty service list rather than silently doing nothing', () => {
    assert.throws(
      () => loadConfig({ UPDATER_TOKEN: VALID_TOKEN, UPDATER_SERVICES: ' , ' }),
      /empty list/,
    );
  });
});

describe('updater config — fly engine (#696)', () => {
  const base = { UPDATER_TOKEN: VALID_TOKEN, UPDATER_ENGINE: 'fly' };

  it('rejects an unknown engine', () => {
    assert.throws(
      () => loadConfig({ UPDATER_TOKEN: VALID_TOKEN, UPDATER_ENGINE: 'kubernetes' }),
      /must be "docker" or "fly"/,
    );
  });

  it('refuses to start without an app for every managed service', () => {
    assert.throws(() => loadConfig(base), /UPDATER_FLY_APP_MIDDLEWARE is required/);
  });

  it('refuses to start without a token for every app', () => {
    assert.throws(
      () =>
        loadConfig({
          ...base,
          UPDATER_SERVICES: 'middleware',
          UPDATER_FLY_APP_MIDDLEWARE: 'omadia-middleware-x',
        }),
      /UPDATER_FLY_TOKEN_MIDDLEWARE is required/,
    );
  });

  it('names app-scoped tokens in the refusal, so nobody reaches for an org token', () => {
    try {
      loadConfig({
        ...base,
        UPDATER_SERVICES: 'middleware',
        UPDATER_FLY_APP_MIDDLEWARE: 'omadia-middleware-x',
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.match(err.message, /APP-SCOPED deploy token/);
      assert.match(err.message, /never an org-wide one/);
    }
  });

  it('maps each service to its app and each app to its own token', () => {
    const config = loadConfig({
      ...base,
      UPDATER_FLY_APP_MIDDLEWARE: 'omadia-middleware-x',
      UPDATER_FLY_TOKEN_MIDDLEWARE: 'fm2_mw',
      // `web-ui` → WEB_UI, so every app is a plain `fly secrets set` away.
      UPDATER_FLY_APP_WEB_UI: 'omadia-web-ui-x',
      UPDATER_FLY_TOKEN_WEB_UI: 'fm2_ui',
    });

    assert.equal(config.engine, 'fly');
    assert.deepEqual(config.flyApps, {
      middleware: 'omadia-middleware-x',
      'web-ui': 'omadia-web-ui-x',
    });
    assert.equal(config.flyTokens['omadia-middleware-x'], 'fm2_mw');
    assert.equal(config.flyTokens['omadia-web-ui-x'], 'fm2_ui');
  });

  it('leaves the docker engine as the default with no fly config at all', () => {
    const config = loadConfig({ UPDATER_TOKEN: VALID_TOKEN });
    assert.equal(config.engine, 'docker');
    assert.deepEqual(config.flyApps, {});
  });
});

describe('isValidTargetVersion', () => {
  it('accepts release tags with and without the v prefix', () => {
    assert.equal(isValidTargetVersion('v0.75.0'), true);
    assert.equal(isValidTargetVersion('0.75.0'), true);
    assert.equal(isValidTargetVersion('v1.0.0-rc.1'), true);
  });

  it('rejects floating tags — they make rollback and the health gate undecidable', () => {
    for (const bad of ['latest', 'edge', 'sha-1a2b3c4', '', 'v1', 'v1.2']) {
      assert.equal(isValidTargetVersion(bad), false, `${bad} must be rejected`);
    }
  });

  it('rejects anything that could smuggle a different image reference', () => {
    for (const bad of [
      'v1.0.0 && rm -rf /',
      'v1.0.0/../../etc',
      'v1.0.0:tag',
      'latest@sha256:abc',
    ]) {
      assert.equal(isValidTargetVersion(bad), false, `${bad} must be rejected`);
    }
  });
});
