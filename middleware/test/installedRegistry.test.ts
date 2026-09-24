import { strict as assert } from 'node:assert';
import { describe, it, type TestContext } from 'node:test';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CIRCUIT_BREAKER_THRESHOLD,
  InMemoryInstalledRegistry,
  type InstalledAgent,
  type InstalledRegistry,
} from '../src/plugins/installedRegistry.js';
import { FileInstalledRegistry } from '../src/plugins/fileInstalledRegistry.js';

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

interface RegistryFixture {
  registry: InstalledRegistry;
  read(id: string): Promise<InstalledAgent | undefined>;
}

const registryBackends: ReadonlyArray<{
  name: string;
  create(t: TestContext): Promise<RegistryFixture>;
}> = [
  {
    name: 'InMemoryInstalledRegistry',
    async create() {
      const registry = new InMemoryInstalledRegistry();
      return { registry, read: async (id) => registry.get(id) };
    },
  },
  {
    name: 'FileInstalledRegistry',
    async create(t) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omadia-reg-block-'));
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const file = path.join(dir, 'installed.json');
      const registry = new FileInstalledRegistry(file);
      await registry.load();
      return {
        registry,
        async read(id) {
          // Every assertion reads a fresh instance, so memory-only writes fail.
          const reloaded = new FileInstalledRegistry(file);
          await reloaded.load();
          return reloaded.get(id);
        },
      };
    },
  },
];

for (const backend of registryBackends) {
  describe(`${backend.name} terminal blocks and counted failures (OM-87)`, () => {
    it('blocks immediately, bounds the error, stamps time and preserves metadata', async (t) => {
      const { registry, read } = await backend.create(t);
      const original = {
        ...activeAgent('a'),
        config: { region: 'eu' },
        last_activated_at: '2026-04-29T01:00:00.000Z',
      };
      await registry.register(original);
      const before = Date.now();
      const error = `duplicate provider: ${'x'.repeat(600)}`;
      await registry.markActivationBlocked('a', error);
      const blocked = await read('a');
      assert.ok(blocked);
      assert.equal(blocked.status, 'errored');
      assert.equal(blocked.activation_failure_count, CIRCUIT_BREAKER_THRESHOLD);
      assert.equal(blocked.last_activation_error, error.slice(0, 500));
      assert.ok(blocked.last_activation_error_at);
      const at = Date.parse(blocked.last_activation_error_at);
      assert.ok(at >= before && at <= Date.now());
      assert.equal(Object.hasOwn(blocked, 'unresolved_requires'), false);
      assert.equal(blocked.installed_at, original.installed_at);
      assert.equal(blocked.installed_version, original.installed_version);
      assert.equal(blocked.last_activated_at, original.last_activated_at);
      assert.deepEqual(blocked.config, original.config);
      assert.equal(original.status, 'active', 'does not mutate the old entry');
    });

    it('clears a stale requires-list when replacing a counted failure with a block', async (t) => {
      const { registry, read } = await backend.create(t);
      await registry.register(activeAgent('a'));
      await registry.markActivationFailed('a', 'missing dependency', ['missing@^1']);
      await registry.markActivationBlocked('a', 'duplicate provider');
      const blocked = await read('a');
      assert.ok(blocked);
      assert.equal(blocked.status, 'errored');
      assert.equal(Object.hasOwn(blocked, 'unresolved_requires'), false);
    });

    for (const previous of [0, 1, CIRCUIT_BREAKER_THRESHOLD, CIRCUIT_BREAKER_THRESHOLD + 4]) {
      it(`repeated blocks keep a stable counter starting at ${previous}`, async (t) => {
        const { registry, read } = await backend.create(t);
        await registry.register({ ...activeAgent('a'), activation_failure_count: previous });
        await registry.markActivationBlocked('a', 'first conflict');
        const first = await read('a');
        await registry.markActivationBlocked('a', 'current conflict');
        const second = await read('a');
        assert.ok(first);
        assert.ok(second);
        assert.equal(first.activation_failure_count, Math.max(previous, CIRCUIT_BREAKER_THRESHOLD));
        assert.equal(second.activation_failure_count, first.activation_failure_count);
        assert.equal(second.status, 'errored');
        assert.equal(second.last_activation_error, 'current conflict');
        assert.ok(Date.parse(second.last_activation_error_at!) >= Date.parse(first.last_activation_error_at!));
        assert.equal(Object.hasOwn(second, 'unresolved_requires'), false);
      });
    }

    it('unknown ids are no-ops for blocked and both counted call shapes', async (t) => {
      const { registry, read } = await backend.create(t);
      const original = activeAgent('a');
      await registry.register(original);
      await registry.markActivationBlocked('unknown', 'conflict');
      await registry.markActivationFailed('unknown', 'transient');
      await registry.markActivationFailed('unknown', 'missing', ['missing@^1']);
      assert.equal(await read('unknown'), undefined);
      assert.deepEqual(await read('a'), original);
    });

    for (const requires of [undefined, ['missing@^1']]) {
      it(`preserves counted failures ${requires ? 'with requires' : 'without requires'}`, async (t) => {
        const { registry, read } = await backend.create(t);
        await registry.register(activeAgent('a'));
        const error = `activation failed: ${'x'.repeat(600)}`;
        for (let attempt = 1; attempt <= CIRCUIT_BREAKER_THRESHOLD + 1; attempt++) {
          const before = Date.now();
          if (requires) await registry.markActivationFailed('a', error, requires);
          else await registry.markActivationFailed('a', error);
          const failed = await read('a');
          assert.ok(failed);
          assert.equal(failed.activation_failure_count, attempt);
          assert.equal(failed.status, attempt < CIRCUIT_BREAKER_THRESHOLD ? 'active' : 'errored');
          assert.equal(failed.last_activation_error, error.slice(0, 500));
          assert.ok(failed.last_activation_error_at);
          assert.ok(Date.parse(failed.last_activation_error_at) >= before);
          assert.deepEqual(failed.unresolved_requires, requires);
        }
      });
    }

    it('counted failures copy requires and still remove them for absent or empty lists', async (t) => {
      const { registry, read } = await backend.create(t);
      for (const replacement of [undefined, []]) {
        await registry.register(activeAgent('a'));
        const requires = ['missing@^1'];
        await registry.markActivationFailed('a', 'missing', requires);
        requires.push('later@^1');
        assert.deepEqual((await read('a'))?.unresolved_requires, ['missing@^1']);
        await registry.markActivationFailed('a', 'changed', replacement);
        assert.equal((await read('a'))?.unresolved_requires, undefined);
        assert.equal((await read('a'))?.activation_failure_count, 2);
        assert.equal((await read('a'))?.status, 'active');
      }
    });

    it('clearing a block restores active and resets the next transient failure to one', async (t) => {
      const { registry, read } = await backend.create(t);
      await registry.register(activeAgent('a'));
      await registry.markActivationBlocked('a', 'conflict');
      await registry.clearActivationError('a');
      assert.deepEqual(await read('a'), activeAgent('a'));
      await registry.markActivationFailed('a', 'transient');
      assert.equal((await read('a'))?.activation_failure_count, 1);
      assert.equal((await read('a'))?.status, 'active');
      await registry.markActivationSucceeded('a');
      const success = await read('a');
      assert.ok(success?.last_activated_at);
      assert.equal(success.activation_failure_count, undefined);
      assert.equal(success.last_activation_error, undefined);
      assert.equal(success.last_activation_error_at, undefined);
      assert.equal(success.unresolved_requires, undefined);
    });
  });
}

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

// ---------------------------------------------------------------------------
// OM-16 — `last_activated_at`
// ---------------------------------------------------------------------------

describe('last_activated_at (OM-16)', () => {
  it('is stamped by markActivationSucceeded, even with no error to clear', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(activeAgent('a'));
    assert.equal(reg.get('a')?.last_activated_at, undefined);

    const before = Date.now();
    await reg.markActivationSucceeded('a');
    const stamped = reg.get('a')?.last_activated_at;

    assert.ok(stamped, 'expected last_activated_at to be set');
    const at = Date.parse(stamped);
    assert.ok(Number.isFinite(at), 'expected a parseable ISO8601 timestamp');
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000);
  });

  it('survives markActivationFailed — a failure never erases the last success', async () => {
    const reg = new InMemoryInstalledRegistry();
    await reg.register(activeAgent('a'));
    await reg.markActivationSucceeded('a');
    const stamped = reg.get('a')?.last_activated_at;

    await reg.markActivationFailed('a', 'boom');

    assert.equal(reg.get('a')?.last_activated_at, stamped);
    assert.equal(reg.get('a')?.activation_failure_count, 1);
  });

  it('FileInstalledRegistry loads a pre-OM-16 file that lacks the field', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omadia-reg-'));
    const file = path.join(dir, 'installed.json');
    // Byte-for-byte an old registry file: no `last_activated_at` anywhere.
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        agents: {
          old: {
            id: 'old',
            installed_version: '1.0.0',
            installed_at: '2025-01-01T00:00:00.000Z',
            status: 'active',
            config: { a: 1 },
          },
        },
      }),
      'utf8',
    );

    const reg = new FileInstalledRegistry(file);
    await reg.load();
    const loaded = reg.get('old');
    assert.ok(loaded, 'old entry must still load');
    assert.equal(loaded.installed_at, '2025-01-01T00:00:00.000Z');
    assert.equal(loaded.last_activated_at, undefined);

    // …and the first successful activation backfills it without disturbing
    // anything else on the entry.
    await reg.markActivationSucceeded('old');
    assert.ok(reg.get('old')?.last_activated_at);
    assert.deepEqual(reg.get('old')?.config, { a: 1 });

    await fs.rm(dir, { recursive: true, force: true });
  });
});
