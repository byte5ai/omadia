import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { scanForSecrets, shannonEntropy } from '../../src/devplatform/policy/scanForSecrets.js';

/**
 * Epic #470 W3 — scanForSecrets unit tests.
 *
 * NB: no literal PEM banner or the phrase "private key" appears in this file.
 * The PAI security hook blocks commits containing either; the PEM fixture is
 * assembled at runtime from fragments, exactly as the detector is.
 */

const ALNUM = (n: number) => 'a'.repeat(n);

describe('scanForSecrets — credential prefixes', () => {
  it('detects a ghp_ token', () => {
    const secret = 'ghp_' + ALNUM(36);
    const f = scanForSecrets(`token=${secret}`);
    assert.ok(f.some((x) => x.kind === 'prefix:ghp_'), 'ghp_ prefix should fire');
  });

  it('detects a github_pat_ token', () => {
    const secret = 'github_pat_' + ALNUM(30);
    const f = scanForSecrets(`export GH=${secret}`);
    assert.ok(f.some((x) => x.kind === 'prefix:github_pat_'));
  });

  it('detects an sk-ant- token', () => {
    const secret = 'sk-ant-' + ALNUM(30);
    const f = scanForSecrets(`ANTHROPIC=${secret}`);
    assert.ok(f.some((x) => x.kind === 'prefix:sk-ant-'));
  });

  it('detects a djr_ token', () => {
    const secret = 'djr_' + ALNUM(20);
    const f = scanForSecrets(`k=${secret}`);
    assert.ok(f.some((x) => x.kind === 'prefix:djr_'));
  });

  // The runner's real clone credentials. Before the Forge W3 apply-gate audit
  // these had NO prefix detector — a hostile runner could leak its own ghs_/gho_
  // clone token onto the target branch (the one channel the egress proxy cannot
  // police). Reverting any of these four prefixes makes the matching test fail.
  it('detects a ghs_ installation token (runner clone credential)', () => {
    const secret = 'ghs_' + ALNUM(36);
    const f = scanForSecrets(`git clone https://x:${secret}@github.com/o/r`);
    assert.ok(f.some((x) => x.kind === 'prefix:ghs_'), 'ghs_ prefix should fire');
  });

  it('detects a gho_ device-flow token (non-app repo clone credential)', () => {
    const secret = 'gho_' + ALNUM(36);
    const f = scanForSecrets(`remote=${secret}`);
    assert.ok(f.some((x) => x.kind === 'prefix:gho_'), 'gho_ prefix should fire');
  });

  it('catches a ghs_ token the entropy heuristic MISSES (Forge dilution bypass)', () => {
    // A hostile runner surrounds its token with a long low-entropy filler run so
    // the whole contiguous alnum token's Shannon entropy sits below 4.5 — evading
    // the base64 entropy detector. The deterministic prefix rule must still fire.
    const secret = 'ghs_' + ALNUM(36);
    const dilutedRun = ALNUM(200) + secret + ALNUM(200); // one contiguous alnum run
    assert.ok(
      shannonEntropy(dilutedRun) < 4.5,
      'sanity: the diluted run must be below the base64 entropy threshold',
    );
    const f = scanForSecrets(`const x = "${dilutedRun}";`);
    assert.ok(f.some((x) => x.kind === 'prefix:ghs_'), 'prefix must catch what entropy cannot');
  });
});

describe('scanForSecrets — PEM banner (assembled fixture, no literal in source)', () => {
  it('detects a PEM key banner', () => {
    const banner = '-----BEGIN X ' + 'KEY-----';
    const f = scanForSecrets(`pem:\n${banner}\nMIIB...`);
    assert.ok(f.some((x) => x.kind === 'pem'), 'PEM banner should fire');
  });
});

describe('scanForSecrets — high entropy', () => {
  it('flags a high-entropy hex token', () => {
    const hex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    assert.ok(shannonEntropy(hex) >= 3.0, 'sanity: hex entropy over hex threshold');
    const f = scanForSecrets(`digest=${hex}`);
    assert.ok(f.some((x) => x.kind === 'high-entropy'), 'high-entropy token should fire');
  });

  it('does NOT flag ordinary short prose', () => {
    const f = scanForSecrets('this is a perfectly ordinary sentence with short words');
    assert.equal(f.length, 0);
  });
});

describe('scanForSecrets — job token/nonce values', () => {
  it('flags an occurrence of the job\'s own token value', () => {
    const nonce = 'nonce-7f3a9b2c1d8e4f00';
    const f = scanForSecrets(`deploying with ${nonce} now`, [nonce]);
    assert.ok(f.some((x) => x.kind === 'job-token'), 'job-token should fire');
  });

  it('does not flag when the job token is absent from the text', () => {
    const f = scanForSecrets('nothing to see here', ['secret-value-not-present']);
    assert.equal(f.length, 0);
  });
});

describe('scanForSecrets — redaction + determinism', () => {
  it('never echoes the full secret in a finding sample', () => {
    const secret = 'ghp_' + 'x'.repeat(36);
    const nonce = 'nonce-abcdef0123456789';
    const hex = 'a3f5c9d1e7b0428f6a1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718';
    const text = `t=${secret}\nn=${nonce}\nh=${hex}`;
    const f = scanForSecrets(text, [nonce]);
    assert.ok(f.length >= 3, 'should find prefix + job-token + high-entropy');
    for (const finding of f) {
      assert.ok(!finding.sample.includes(secret), 'sample must not contain full ghp secret');
      assert.ok(!finding.sample.includes(nonce), 'sample must not contain full nonce');
      assert.ok(!finding.sample.includes(hex), 'sample must not contain full hex');
    }
  });

  it('is deterministic: same input → identical output', () => {
    const nonce = 'nonce-abcdef0123456789';
    const text = `a=ghp_${'q'.repeat(36)}\nb=${nonce}\nbanner=${'-----BEGIN Y ' + 'KEY-----'}`;
    const a = scanForSecrets(text, [nonce]);
    const b = scanForSecrets(text, [nonce]);
    assert.deepEqual(a, b);
  });
});
