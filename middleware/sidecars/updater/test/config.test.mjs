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
