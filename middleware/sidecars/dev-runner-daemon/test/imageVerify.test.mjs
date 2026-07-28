/**
 * Epic #470 W5 — runner image verify-at-boot decision logic (spec §10).
 *
 * The cosign shell-out is INJECTED, so these prove the DECISION core without a
 * cosign binary present:
 *   - mode=off               → no cosign call, skipped ok;
 *   - mode=on + exit 0       → verified ok;
 *   - mode=on + non-zero     → REFUSES (throws ImageVerificationError);
 *   - mode=on + no identity  → skipped with a warning, no cosign call;
 *   - the cosign argv pins --certificate-identity + --certificate-oidc-issuer;
 *   - `verifyConfiguredImages` verifies each image and the FIRST failure aborts;
 *   - `resolveImageVerifyMode` default-on / explicit-off / unknown→on.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createCosignExec,
  ImageVerificationError,
  resolveImageVerifyMode,
  verifyConfiguredImages,
  verifyRunnerImage,
} from '../src/imageVerify.mjs';

const IMAGE = 'ghcr.io/byte5ai/omadia-dev-runner@sha256:' + '1'.repeat(64);
const IDENTITY = 'https://github.com/byte5ai/omadia/.github/workflows/publish-images.yml@refs/tags/v1.2.3';
const ISSUER = 'https://token.actions.githubusercontent.com';

/** A cosign exec fake: records the argv it was called with and returns `result`. */
function fakeExec(result) {
  /** @type {readonly string[][]} */
  const calls = [];
  const exec = async (args) => {
    calls.push([...args]);
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { exec, calls };
}

/** A logger that records warn/info messages so we can assert on them. */
function fakeLogger() {
  const warns = [];
  const infos = [];
  return {
    warn: (m) => warns.push(m),
    info: (m) => infos.push(m),
    warns,
    infos,
  };
}

describe('resolveImageVerifyMode', () => {
  it('defaults to on when unset', () => {
    assert.equal(resolveImageVerifyMode(undefined), 'on');
  });
  it('is off for falsey spellings', () => {
    for (const v of ['off', 'OFF', 'false', '0', 'no', ' Off ']) {
      assert.equal(resolveImageVerifyMode(v), 'off', `${v} should disable`);
    }
  });
  it('is on for truthy spellings', () => {
    for (const v of ['on', 'true', '1', 'YES']) {
      assert.equal(resolveImageVerifyMode(v), 'on', `${v} should enable`);
    }
  });
  it('treats an unknown value as on (fail-safe)', () => {
    assert.equal(resolveImageVerifyMode('maybe'), 'on');
  });
});

describe('verifyRunnerImage — decision core', () => {
  it('mode=off → SKIPS with no cosign call', async () => {
    const { exec, calls } = fakeExec({ code: 0 });
    const logger = fakeLogger();
    const out = await verifyRunnerImage({ image: IMAGE, identity: IDENTITY, issuer: ISSUER, mode: 'off', exec, logger });
    assert.deepEqual(out, { verified: false, skipped: true, reason: 'disabled' });
    assert.equal(calls.length, 0, 'cosign must not be invoked when disabled');
    assert.equal(logger.warns.length, 1);
  });

  it('mode=on + cosign exit 0 → VERIFIED, argv pins identity + issuer', async () => {
    const { exec, calls } = fakeExec({ code: 0 });
    const out = await verifyRunnerImage({ image: IMAGE, identity: IDENTITY, issuer: ISSUER, mode: 'on', exec });
    assert.deepEqual(out, { verified: true, skipped: false });
    assert.equal(calls.length, 1);
    const argv = calls[0];
    assert.deepEqual(argv, [
      'verify',
      '--certificate-identity',
      IDENTITY,
      '--certificate-oidc-issuer',
      ISSUER,
      IMAGE,
    ]);
  });

  it('mode=on + cosign non-zero → REFUSES (throws ImageVerificationError)', async () => {
    const { exec } = fakeExec({ code: 1, stderr: 'error: no matching signatures' });
    await assert.rejects(
      () => verifyRunnerImage({ image: IMAGE, identity: IDENTITY, issuer: ISSUER, mode: 'on', exec }),
      (err) => {
        assert.ok(err instanceof ImageVerificationError);
        assert.equal(err.image, IMAGE);
        assert.match(err.message, /no matching signatures/);
        assert.match(err.message, /refusing to run an unverified runner image/);
        return true;
      },
    );
  });

  it('mode=on but no identity → SKIPS with a warning, no cosign call', async () => {
    const { exec, calls } = fakeExec({ code: 0 });
    const logger = fakeLogger();
    const out = await verifyRunnerImage({ image: IMAGE, identity: undefined, issuer: ISSUER, mode: 'on', exec, logger });
    assert.deepEqual(out, { verified: false, skipped: true, reason: 'no-identity' });
    assert.equal(calls.length, 0, 'cannot verify without a pinned identity');
    assert.equal(logger.warns.length, 1);
    assert.match(logger.warns[0], /no cosign identity\/issuer is configured/);
  });

  it('mode=on but no issuer → SKIPS (identity alone is not enough)', async () => {
    const { exec, calls } = fakeExec({ code: 0 });
    const out = await verifyRunnerImage({ image: IMAGE, identity: IDENTITY, issuer: undefined, mode: 'on', exec });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'no-identity');
    assert.equal(calls.length, 0);
  });

  it('surfaces a spawn failure (cosign missing, non-zero code) as a refusal', async () => {
    // createCosignExec maps ENOENT to a non-zero code; verifyRunnerImage refuses.
    const { exec } = fakeExec({ code: 127, stderr: '' });
    await assert.rejects(
      () => verifyRunnerImage({ image: IMAGE, identity: IDENTITY, issuer: ISSUER, mode: 'on', exec }),
      ImageVerificationError,
    );
  });
});

describe('verifyConfiguredImages — boot loop', () => {
  it('mode=off → skips all, no cosign call', async () => {
    const { exec, calls } = fakeExec({ code: 0 });
    const logger = fakeLogger();
    const res = await verifyConfiguredImages({
      images: [IMAGE, IMAGE],
      identity: IDENTITY,
      issuer: ISSUER,
      mode: 'off',
      exec,
      logger,
    });
    assert.equal(res.mode, 'off');
    assert.deepEqual(res.results, []);
    assert.equal(calls.length, 0);
    assert.equal(logger.warns.length, 1, 'one warning, not one per image');
  });

  it('no identity → skips with ONE warning regardless of image count', async () => {
    const { exec, calls } = fakeExec({ code: 0 });
    const logger = fakeLogger();
    const res = await verifyConfiguredImages({
      images: [IMAGE, IMAGE, IMAGE],
      identity: undefined,
      issuer: ISSUER,
      mode: 'on',
      exec,
      logger,
    });
    assert.deepEqual(res.results, []);
    assert.equal(calls.length, 0);
    assert.equal(logger.warns.length, 1);
  });

  it('no images configured → warns, verifies nothing', async () => {
    const { exec, calls } = fakeExec({ code: 0 });
    const logger = fakeLogger();
    const res = await verifyConfiguredImages({
      images: [],
      identity: IDENTITY,
      issuer: ISSUER,
      mode: 'on',
      exec,
      logger,
    });
    assert.deepEqual(res.results, []);
    assert.equal(calls.length, 0);
    assert.match(logger.warns[0], /no images are configured/);
  });

  it('mode=on + all verify → one outcome per image', async () => {
    const { exec, calls } = fakeExec({ code: 0 });
    const res = await verifyConfiguredImages({
      images: [IMAGE, IMAGE],
      identity: IDENTITY,
      issuer: ISSUER,
      mode: 'on',
      exec,
    });
    assert.equal(res.results.length, 2);
    assert.ok(res.results.every((r) => r.verified));
    assert.equal(calls.length, 2);
  });

  it('FIRST failure aborts the loop (throws, does not verify the rest)', async () => {
    // A per-call exec that fails on the first image only would still throw on
    // the first, so a single failing exec proves the abort.
    const { exec, calls } = fakeExec({ code: 1, stderr: 'bad sig' });
    await assert.rejects(
      () =>
        verifyConfiguredImages({
          images: [IMAGE, IMAGE],
          identity: IDENTITY,
          issuer: ISSUER,
          mode: 'on',
          exec,
        }),
      ImageVerificationError,
    );
    assert.equal(calls.length, 1, 'the second image is never reached');
  });
});

describe('createCosignExec', () => {
  it('returns a non-zero code (not a rejection) when the binary is missing', async () => {
    const exec = createCosignExec('definitely-not-a-real-cosign-binary-xyz');
    const result = await exec(['verify', IMAGE]);
    assert.notEqual(result.code, 0, 'a spawn failure surfaces as a non-zero code');
  });
});
