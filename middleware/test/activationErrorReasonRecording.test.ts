/**
 * #1456 — the classified reason must survive the same round trip the raw
 * sentence already survives: recorded with the failure, persisted, cleared on
 * success, and projected to the operator through readiness.
 *
 * Both registry backends are exercised, because the two have independent
 * copies of the failure writes and a field that only lands in memory would
 * read as "no reason" after the next boot — which is the pre-upgrade state
 * this issue is fixing.
 */

import { strict as assert } from 'node:assert';
import { describe, it, type TestContext } from 'node:test';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  InMemoryInstalledRegistry,
  recordActivationFailure,
  type InstalledAgent,
  type InstalledRegistry,
} from '../src/plugins/installedRegistry.js';
import { FileInstalledRegistry } from '../src/plugins/fileInstalledRegistry.js';
import { computeReadiness } from '../src/plugins/readiness.js';
import type { ActivationErrorReason } from '../src/plugins/activationErrorReason.js';
import { MissingSecretError } from '@omadia/plugin-api';

const SECRET_MISSING: ActivationErrorReason = {
  code: 'secret_missing',
  field: 'odoo_api_key',
};

function activeAgent(id: string): InstalledAgent {
  return {
    id,
    installed_version: '0.2.0',
    installed_at: '2026-10-28T00:00:00.000Z',
    status: 'active',
    config: {},
  };
}

interface RegistryFixture {
  registry: InstalledRegistry;
  read(id: string): Promise<InstalledAgent | undefined>;
}

const backends: ReadonlyArray<{
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omadia-reg-reason-'));
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const file = path.join(dir, 'installed.json');
      const registry = new FileInstalledRegistry(file);
      await registry.load();
      return {
        registry,
        async read(id) {
          const reloaded = new FileInstalledRegistry(file);
          await reloaded.load();
          return reloaded.get(id);
        },
      };
    },
  },
];

for (const backend of backends) {
  describe(`${backend.name} activation-error reason (#1456)`, () => {
    it('persists the reason alongside the raw sentence', async (t) => {
      const { registry, read } = await backend.create(t);
      await registry.register(activeAgent('a'));
      await registry.markActivationFailed(
        'a',
        "plugin 'a' has no secret 'odoo_api_key' in vault",
        undefined,
        SECRET_MISSING,
      );
      const got = await read('a');
      assert.deepEqual(got?.last_activation_error_reason, SECRET_MISSING);
      assert.equal(
        got?.last_activation_error,
        "plugin 'a' has no secret 'odoo_api_key' in vault",
      );
    });

    it('drops a stale reason when the next failure brings none', async (t) => {
      const { registry, read } = await backend.create(t);
      await registry.register(activeAgent('a'));
      await registry.markActivationFailed('a', 'first', undefined, SECRET_MISSING);
      await registry.markActivationFailed('a', 'second');
      const got = await read('a');
      assert.ok(got);
      assert.equal(Object.hasOwn(got, 'last_activation_error_reason'), false);
    });

    it('clears the reason on a successful activation', async (t) => {
      const { registry, read } = await backend.create(t);
      await registry.register(activeAgent('a'));
      await registry.markActivationFailed('a', 'nope', undefined, SECRET_MISSING);
      await registry.markActivationSucceeded('a');
      const got = await read('a');
      assert.ok(got);
      assert.equal(Object.hasOwn(got, 'last_activation_error_reason'), false);
    });

    it('clears the reason when the circuit breaker is lifted', async (t) => {
      const { registry, read } = await backend.create(t);
      await registry.register({ ...activeAgent('a'), status: 'errored' });
      await registry.markActivationFailed('a', 'nope', undefined, SECRET_MISSING);
      await registry.clearActivationError('a');
      const got = await read('a');
      assert.ok(got);
      assert.equal(got.status, 'active');
      assert.equal(Object.hasOwn(got, 'last_activation_error_reason'), false);
    });

    it('records a reason on a terminal block too', async (t) => {
      const { registry, read } = await backend.create(t);
      await registry.register(activeAgent('a'));
      await registry.markActivationBlocked('a', 'duplicate provider', {
        code: 'capability_not_declared',
        capability: 'entityRefBus',
      });
      const got = await read('a');
      assert.equal(got?.status, 'errored');
      assert.deepEqual(got?.last_activation_error_reason, {
        code: 'capability_not_declared',
        capability: 'entityRefBus',
      });
    });
  });
}

describe('recordActivationFailure classifies the throw it is handed (#1456)', () => {
  it('derives the reason from the error object', async () => {
    const registry = new InMemoryInstalledRegistry();
    await registry.register(activeAgent('a'));
    const err = new MissingSecretError('a', 'odoo_api_key');
    await recordActivationFailure(registry, 'a', err.message, undefined, err);
    assert.deepEqual(registry.get('a')?.last_activation_error_reason, SECRET_MISSING);
  });

  it('records no reason when the caller has no error object to classify', async () => {
    const registry = new InMemoryInstalledRegistry();
    await registry.register(activeAgent('a'));
    await recordActivationFailure(registry, 'a', 'something went wrong');
    const got = registry.get('a');
    assert.ok(got);
    assert.equal(Object.hasOwn(got, 'last_activation_error_reason'), false);
  });
});

describe('readiness projects the reason next to the raw detail (#1456)', () => {
  const plugin = { id: 'a', setup_fields: [] };

  it('carries the reason for an errored plugin', async () => {
    const registry = new InMemoryInstalledRegistry();
    await registry.register({ ...activeAgent('a'), status: 'errored' });
    const err = new MissingSecretError('a', 'odoo_api_key');
    await recordActivationFailure(registry, 'a', err.message, undefined, err);
    const readiness = await computeReadiness(plugin, registry);
    assert.equal(readiness.state, 'errored');
    assert.deepEqual(readiness.error_reason, SECRET_MISSING);
    assert.equal(readiness.error_detail, err.message);
  });

  it('omits the reason for a registry entry written before the field existed', async () => {
    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      ...activeAgent('a'),
      status: 'errored',
      last_activation_error: 'an old English sentence',
    });
    const readiness = await computeReadiness(plugin, registry);
    assert.equal(readiness.error_detail, 'an old English sentence');
    assert.equal(Object.hasOwn(readiness, 'error_reason'), false);
  });
});
