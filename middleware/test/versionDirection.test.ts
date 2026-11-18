import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { versionDirection } from '../src/plugins/versionDirection.js';

/**
 * #1455 — the comparison the ingest guard rests on. Prerelease ordering is the
 * part that is easy to get wrong, and getting it wrong either refuses a real
 * upgrade or waves a downgrade through.
 */
describe('versionDirection', () => {
  it('reads a higher version as an upgrade and a lower one as a downgrade', () => {
    assert.equal(versionDirection('0.2.0', '0.2.1'), 'upgrade');
    assert.equal(versionDirection('0.2.1', '0.2.0'), 'downgrade');
    assert.equal(versionDirection('0.9.0', '1.0.0'), 'upgrade');
    assert.equal(versionDirection('1.0.0', '0.9.0'), 'downgrade');
    // Not lexical: 0.10.0 outranks 0.9.0, and 2.0.0 outranks 10.0.0 it is not.
    assert.equal(versionDirection('0.9.0', '0.10.0'), 'upgrade');
    assert.equal(versionDirection('0.10.0', '0.9.0'), 'downgrade');
    assert.equal(versionDirection('2.0.0', '10.0.0'), 'upgrade');
  });

  it('is null for equal versions — the duplicate-version refusal owns that case', () => {
    assert.equal(versionDirection('1.2.3', '1.2.3'), null);
  });

  it('ranks a final release above its own prereleases (semver §11)', () => {
    assert.equal(versionDirection('1.0.0-rc.1', '1.0.0'), 'upgrade');
    assert.equal(versionDirection('1.0.0', '1.0.0-rc.1'), 'downgrade');
    assert.equal(versionDirection('1.0.0-rc.1', '1.0.0-rc.2'), 'upgrade');
    assert.equal(versionDirection('1.0.0-rc.2', '1.0.0-rc.1'), 'downgrade');
    // Numeric identifiers compare numerically, not as strings.
    assert.equal(versionDirection('1.0.0-rc.9', '1.0.0-rc.10'), 'upgrade');
    // Numeric ranks below alphanumeric.
    assert.equal(versionDirection('1.0.0-1', '1.0.0-alpha'), 'upgrade');
  });

  it('ignores build metadata (semver §10)', () => {
    assert.equal(versionDirection('1.0.0+build.1', '1.0.0+build.2'), null);
    assert.equal(versionDirection('1.0.0+build.9', '1.0.1'), 'upgrade');
  });

  it('reports no direction at all when a side cannot be parsed', () => {
    // A hand-edited index.json is the only way these reach the guard. Calling
    // them downgrades would refuse an ingest on a comparison that never ran;
    // calling them upgrades would put a direction nobody computed into the
    // response and the log. Neither — the caller treats null as "not a
    // downgrade" and reports nothing.
    assert.equal(versionDirection('edge', '1.0.0'), null);
    assert.equal(versionDirection('1.0.0', 'edge'), null);
    assert.equal(versionDirection('', '1.0.0'), null);
  });
});
