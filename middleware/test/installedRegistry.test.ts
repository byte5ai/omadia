import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CIRCUIT_BREAKER_THRESHOLD,
  InMemoryInstalledRegistry,
  type InstalledAgent,
} from '../src/plugins/installedRegistry.js';

/**
 * Registry-side coverage for S+8.5 sub-commit 3:
 *   - `markActivationFailed` accepts an optional `unresolvedRequires` list
 *     and persists it alongside the error fields.
 *   - `markActivationSucceeded` clears every error field, including
 *     `unresolved_requires`.
 *   - `clearActivationError` lifts a sticky `errored` status back to
 *     `active` and wipes every error field, *without* requiring a fresh
 *     activation attempt.
 *
 * The InMemoryInstalledRegistry is the test surface; FileInstalledRegistry
 * mirrors the same contract (verified separately when persistence is
 * exercised end-to-end).
 */

function activeAgent(id: string): InstalledAgent {
  return {
    id,
    installed_version: '0.1.0',
    installed_at: '2026-04-29T00:00:00Z',
    status: 'active',
    config: {},
  };
}

describe('InstalledRegistry.markActivationFailed (with unresolvedRequires)', () => {
  it('persists unresolved_requires alongside error fields', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(activeAgent('a'));
    await reg.markActivationFailed('a', 'unresolved capability requires: x@^1', [
      'x@^1',
    ]);
    const got = reg.get('a');
    assert.deepEqual(got?.unresolved_requires, ['x@^1']);
    assert.equal(got?.last_activation_error, 'unresolved capability requires: x@^1');
    assert.ok(got?.last_activation_error_at);
    assert.equal(got?.activation_failure_count, 1);
    // 1 fail < threshold (3) → status stays 'active'.
    assert.equal(got?.status, 'active');
  });

  it('flips status to errored once threshold is reached', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(activeAgent('a'));
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      await reg.markActivationFailed('a', 'unresolved', ['x@^1']);
    }
    const got = reg.get('a');
    assert.equal(got?.status, 'errored');
    assert.equal(got?.activation_failure_count, CIRCUIT_BREAKER_THRESHOLD);
    assert.deepEqual(got?.unresolved_requires, ['x@^1']);
  });

  it('drops unresolved_requires when called without the optional arg', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register({ ...activeAgent('a'), unresolved_requires: ['old@^1'] });
    await reg.markActivationFailed('a', 'plain runtime error');
    assert.equal(reg.get('a')?.unresolved_requires, undefined);
  });

  it('is a no-op for unknown agent ids', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.markActivationFailed('does-not-exist', 'msg', ['x@^1']);
    assert.equal(reg.get('does-not-exist'), undefined);
  });
});

describe('InstalledRegistry.markActivationSucceeded', () => {
  it('clears unresolved_requires alongside the other error fields', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(activeAgent('a'));
    await reg.markActivationFailed('a', 'unresolved', ['x@^1']);
    await reg.markActivationSucceeded('a');
    const got = reg.get('a');
    assert.equal(got?.activation_failure_count, undefined);
    assert.equal(got?.last_activation_error, undefined);
    assert.equal(got?.last_activation_error_at, undefined);
    assert.equal(got?.unresolved_requires, undefined);
  });
});

describe('InstalledRegistry.clearActivationError', () => {
  it('lifts status:errored → active and wipes every error field', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register({
      ...activeAgent('a'),
      status: 'errored',
      activation_failure_count: 4,
      last_activation_error: 'unresolved capability requires: x@^1',
      last_activation_error_at: '2026-04-29T05:00:00Z',
      unresolved_requires: ['x@^1'],
    });
    await reg.clearActivationError('a');
    const got = reg.get('a');
    assert.equal(got?.status, 'active');
    assert.equal(got?.activation_failure_count, undefined);
    assert.equal(got?.last_activation_error, undefined);
    assert.equal(got?.last_activation_error_at, undefined);
    assert.equal(got?.unresolved_requires, undefined);
  });

  it('is idempotent on a clean entry (no error fields, status:active)', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(activeAgent('a'));
    const before = reg.get('a');
    await reg.clearActivationError('a');
    assert.deepEqual(reg.get('a'), before);
  });

  it('is a no-op for unknown agent ids', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.clearActivationError('does-not-exist');
    assert.equal(reg.get('does-not-exist'), undefined);
  });

  it('keeps a manually-set inactive entry inactive (only lifts errored)', async () => {
    // The contract is "lift errored → active". An operator-set
    // 'inactive' is a deliberate choice and not touched by this method.
    const reg = new InMemoryInstalledRegistry();
    await reg.register({
      ...activeAgent('a'),
      status: 'inactive',
    });
    await reg.clearActivationError('a');
    assert.equal(reg.get('a')?.status, 'inactive');
  });
});
