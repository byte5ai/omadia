import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SANDBOX_RESOURCE_LIMITS, SANDBOX_RESOURCE_LIMIT_ENV_KEYS } from '@omadia/sandbox';
import { loadManifestFromPath } from '../../src/plugins/manifestLoader.js';
import {
  SANDBOX_LIMIT_CONFIG_KEYS,
  describeSandboxResourceLimits,
  readSandboxResourceLimits,
} from '../../packages/harness-orchestrator/src/sandboxLimitsConfig.js';

/**
 * The orchestrator's setup fields for the sandbox container ceilings. Both
 * Docker paths (`execute` and `publish`) are built from ONE reading of these
 * keys in `plugin.ts`, so this mapping is what an operator's setting reaches.
 * Precedence per field: setup field > `OMADIA_SANDBOX_*` env > built-in
 * default, the same order `cli_turn_seconds` uses (OM-104).
 */

const MANIFEST = fileURLToPath(new URL('../../packages/harness-orchestrator/manifest.yaml', import.meta.url));

function configGetter(config: Record<string, unknown>): (key: string) => unknown {
  return (key) => config[key];
}

describe('readSandboxResourceLimits', () => {
  it('reads sandbox_memory_mb, sandbox_cpus and sandbox_pids_limit', () => {
    assert.deepEqual(SANDBOX_LIMIT_CONFIG_KEYS, {
      memoryMb: 'sandbox_memory_mb',
      cpus: 'sandbox_cpus',
      pidsLimit: 'sandbox_pids_limit',
    });
    const get = configGetter({ sandbox_memory_mb: '1024', sandbox_cpus: 2, sandbox_pids_limit: '128' });
    assert.deepEqual(readSandboxResourceLimits(get, {}), { memoryMb: 1024, cpus: 2, pidsLimit: 128 });
  });

  it('falls back to the defaults for unset, empty, junk and zero values', () => {
    const get = configGetter({ sandbox_memory_mb: '', sandbox_cpus: 'x', sandbox_pids_limit: 0 });
    assert.deepEqual(readSandboxResourceLimits(get, {}), { memoryMb: 512, cpus: 1, pidsLimit: 256 });
    assert.deepEqual(readSandboxResourceLimits(configGetter({}), {}), { memoryMb: 512, cpus: 1, pidsLimit: 256 });
  });

  it('a setting wins over the env variable; an unset setting leaves the env variable in charge', () => {
    const env = { OMADIA_SANDBOX_MEMORY_MB: '768', OMADIA_SANDBOX_CPUS: '0.5' };
    const get = configGetter({ sandbox_memory_mb: '2048' });
    assert.deepEqual(readSandboxResourceLimits(get, env), { memoryMb: 2048, cpus: 0.5, pidsLimit: 256 });
  });

  it('a setting Docker would apply as no limit counts as unset, like junk', () => {
    const get = configGetter({ sandbox_memory_mb: '1e21', sandbox_cpus: '0.000001', sandbox_pids_limit: '4194305' });
    assert.deepEqual(readSandboxResourceLimits(get, {}), { memoryMb: 512, cpus: 1, pidsLimit: 256 });
    const huge = configGetter({ sandbox_cpus: '1e64' });
    assert.equal(readSandboxResourceLimits(huge, { OMADIA_SANDBOX_CPUS: '2' }).cpus, 2);
  });

  it('describes the effective limits for the boot log', () => {
    assert.equal(
      describeSandboxResourceLimits({ memoryMb: 512, cpus: 1, pidsLimit: 256 }),
      'memory=512m cpus=1 pids=256',
    );
  });
});

describe('orchestrator manifest — sandbox limit setup fields', () => {
  it('declares all three keys as optional string fields, so operators can edit them', async () => {
    const entry = await loadManifestFromPath(MANIFEST);
    assert.ok(entry, 'orchestrator manifest.yaml failed to load');
    const fields = entry.plugin.setup_fields ?? [];
    for (const key of Object.values(SANDBOX_LIMIT_CONFIG_KEYS)) {
      const field = fields.find((f) => f.key === key);
      assert.ok(field, `missing setup field: ${key}`);
      assert.equal(field.type, 'string', `${key} should be type string`);
      assert.notEqual(field.required, true, `${key} must stay optional`);
    }
  });
});

describe('.env.example — sandbox limit variables', () => {
  it('documents every OMADIA_SANDBOX_* variable with its default', () => {
    const envExample = readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');
    for (const field of Object.keys(SANDBOX_RESOURCE_LIMIT_ENV_KEYS) as Array<keyof typeof SANDBOX_RESOURCE_LIMIT_ENV_KEYS>) {
      const line = `# ${SANDBOX_RESOURCE_LIMIT_ENV_KEYS[field]}=${String(DEFAULT_SANDBOX_RESOURCE_LIMITS[field])}`;
      assert.ok(envExample.includes(line), `.env.example must document "${line}"`);
    }
  });
});
