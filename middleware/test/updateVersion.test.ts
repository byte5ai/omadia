import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  compareVersions,
  isNewerVersion,
  parseVersion,
  toTag,
} from '../src/update/semver.js';
import { resolveAppVersion } from '../src/update/version.js';

/**
 * #432 slice 1 — the version surface.
 *
 * The comparison rules are what decide whether an operator is shown an
 * "update available" badge, and the classification is what decides whether the
 * updater's health gate can ever succeed, so both are pinned here rather than
 * left to the shape of whatever tag CI happens to produce.
 */

describe('parseVersion', () => {
  it('accepts release tags with and without the v prefix', () => {
    assert.deepEqual(parseVersion('v0.74.0'), {
      major: 0,
      minor: 74,
      patch: 0,
      prerelease: [],
    });
    assert.deepEqual(parseVersion('0.74.0'), {
      major: 0,
      minor: 74,
      patch: 0,
      prerelease: [],
    });
  });

  it('keeps prerelease identifiers and discards build metadata', () => {
    assert.deepEqual(parseVersion('v1.0.0-rc.2+build.7')?.prerelease, ['rc', '2']);
  });

  it('returns null for the floating tags CI also publishes', () => {
    for (const tag of ['latest', 'edge', 'sha-1a2b3c4', 'v1.2', '', 'nonsense']) {
      assert.equal(parseVersion(tag), null, `${tag} must not parse`);
    }
  });

  it('returns null rather than throwing for absent input', () => {
    assert.equal(parseVersion(undefined), null);
    assert.equal(parseVersion(null), null);
  });
});

describe('compareVersions', () => {
  const p = (s: string) => {
    const parsed = parseVersion(s);
    assert.ok(parsed !== null, `${s} should parse`);
    return parsed;
  };

  it('orders by major, then minor, then patch', () => {
    assert.ok(compareVersions(p('v1.0.0'), p('v0.99.99')) > 0);
    assert.ok(compareVersions(p('v0.74.0'), p('v0.75.0')) < 0);
    assert.ok(compareVersions(p('v0.74.1'), p('v0.74.0')) > 0);
    assert.equal(compareVersions(p('v0.74.0'), p('0.74.0')), 0);
  });

  it('ranks a prerelease below its own final release', () => {
    assert.ok(compareVersions(p('v1.0.0-rc.1'), p('v1.0.0')) < 0);
    assert.ok(compareVersions(p('v1.0.0'), p('v1.0.0-rc.1')) > 0);
  });

  it('orders prerelease identifiers numerically, then lexically', () => {
    assert.ok(compareVersions(p('v1.0.0-rc.2'), p('v1.0.0-rc.10')) < 0);
    assert.ok(compareVersions(p('v1.0.0-alpha'), p('v1.0.0-beta')) < 0);
    assert.ok(compareVersions(p('v1.0.0-rc'), p('v1.0.0-rc.1')) < 0);
  });
});

describe('isNewerVersion', () => {
  it('is true only for a strictly newer release', () => {
    assert.equal(isNewerVersion('v0.74.0', 'v0.75.0'), true);
    assert.equal(isNewerVersion('v0.74.0', 'v0.74.0'), false);
    assert.equal(isNewerVersion('v0.75.0', 'v0.74.0'), false);
  });

  it('never claims an upgrade when either side is a floating tag', () => {
    // An `:edge` deployment being told "v0.74.0 is available" would push the
    // operator to DOWNGRADE onto the last release.
    assert.equal(isNewerVersion('edge', 'v0.74.0'), false);
    assert.equal(isNewerVersion('latest', 'v0.74.0'), false);
    assert.equal(isNewerVersion('sha-1a2b3c4', 'v99.0.0'), false);
    assert.equal(isNewerVersion('unknown', 'v99.0.0'), false);
    assert.equal(isNewerVersion('v0.1.0', 'edge'), false);
  });
});

describe('toTag', () => {
  it('canonicalises to the v-prefixed form', () => {
    assert.equal(toTag('0.75.0'), 'v0.75.0');
    assert.equal(toTag('v0.75.0'), 'v0.75.0');
    assert.equal(toTag(' 1.0.0-rc.1 '), 'v1.0.0-rc.1');
  });

  it('leaves a floating tag as its own display form', () => {
    assert.equal(toTag('edge'), 'edge');
    assert.equal(toTag(' latest '), 'latest');
  });
});

describe('resolveAppVersion', () => {
  it('classifies a stamped release build as comparable', () => {
    assert.deepEqual(resolveAppVersion({ OMADIA_VERSION: 'v0.74.0' }), {
      version: 'v0.74.0',
      source: 'release',
    });
  });

  it('classifies a moving tag as floating', () => {
    assert.deepEqual(resolveAppVersion({ OMADIA_VERSION: 'edge' }), {
      version: 'edge',
      source: 'floating',
    });
    assert.equal(resolveAppVersion({ OMADIA_VERSION: 'sha-1a2b3c4' }).source, 'floating');
  });

  it('reports unknown for an unstamped build instead of guessing', () => {
    // Regression guard for the bug this slice fixes: package.json still reads
    // 0.2.0, so ANY fallback to it would report a version that has not been
    // shipped in dozens of releases.
    for (const env of [{}, { OMADIA_VERSION: '' }, { OMADIA_VERSION: '   ' }]) {
      const resolved = resolveAppVersion(env);
      assert.equal(resolved.version, 'unknown');
      assert.equal(resolved.source, 'unknown');
      assert.notEqual(resolved.version, '0.2.0');
    }
  });

  it('trims a stamp that picked up whitespace from a build arg', () => {
    assert.equal(resolveAppVersion({ OMADIA_VERSION: ' v0.74.0 ' }).version, 'v0.74.0');
  });
});
