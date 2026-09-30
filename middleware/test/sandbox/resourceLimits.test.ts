import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  SANDBOX_RESOURCE_LIMIT_ENV_KEYS,
  dockerResourceLimitArgs,
  resolveSandboxResourceLimits,
} from '../../packages/harness-sandbox/src/resourceLimits.js';

/**
 * Hard container ceilings shared by every `docker run` site (sandbox +
 * publish). The resolver is the ONE place a limit value is validated; the
 * backends and the orchestrator config reader all go through it, so these
 * cases are the contract: setting > env > default per field, and a value that
 * would mean "unlimited" to Docker (0, negative, junk) never reaches argv.
 */

const NO_ENV = {};

describe('DEFAULT_SANDBOX_RESOURCE_LIMITS', () => {
  it('is 512 MiB / 1 CPU / 256 PIDs and frozen', () => {
    assert.deepEqual(DEFAULT_SANDBOX_RESOURCE_LIMITS, { memoryMb: 512, cpus: 1, pidsLimit: 256 });
    assert.ok(Object.isFrozen(DEFAULT_SANDBOX_RESOURCE_LIMITS));
  });

  it('pins the documented env variable names', () => {
    assert.deepEqual(SANDBOX_RESOURCE_LIMIT_ENV_KEYS, {
      memoryMb: 'OMADIA_SANDBOX_MEMORY_MB',
      cpus: 'OMADIA_SANDBOX_CPUS',
      pidsLimit: 'OMADIA_SANDBOX_PIDS_LIMIT',
    });
  });
});

describe('resolveSandboxResourceLimits', () => {
  it('returns the defaults with no setting and no env', () => {
    const limits = resolveSandboxResourceLimits({}, NO_ENV);
    assert.deepEqual(limits, DEFAULT_SANDBOX_RESOURCE_LIMITS);
    assert.ok(Object.isFrozen(limits));
  });

  it('accepts numbers and numeric strings, including fractional CPUs', () => {
    assert.deepEqual(resolveSandboxResourceLimits({ memoryMb: 1024, cpus: 0.5, pidsLimit: '512' }, NO_ENV), {
      memoryMb: 1024,
      cpus: 0.5,
      pidsLimit: 512,
    });
    assert.deepEqual(resolveSandboxResourceLimits({ memoryMb: ' 2048 ', cpus: '1.5', pidsLimit: 64 }, NO_ENV), {
      memoryMb: 2048,
      cpus: 1.5,
      pidsLimit: 64,
    });
  });

  for (const junk of [undefined, null, '', '   ', 'abc', 0, '0', -1, '-5', Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
    const label = typeof junk === 'string' || (typeof junk === 'object' && junk !== null) ? JSON.stringify(junk) : String(junk);
    it(`falls back per field for ${label} — never to "unlimited"`, () => {
      assert.deepEqual(
        resolveSandboxResourceLimits({ memoryMb: junk, cpus: junk, pidsLimit: junk }, NO_ENV),
        DEFAULT_SANDBOX_RESOURCE_LIMITS,
      );
    });
  }

  it('rejects fractional memory and PID values instead of rounding them', () => {
    assert.deepEqual(
      resolveSandboxResourceLimits({ memoryMb: 512.5, pidsLimit: '10.5' }, NO_ENV),
      DEFAULT_SANDBOX_RESOURCE_LIMITS,
    );
  });

  it('takes a field from its env variable when there is no setting for it', () => {
    const env = {
      OMADIA_SANDBOX_MEMORY_MB: '768',
      OMADIA_SANDBOX_CPUS: '2',
      OMADIA_SANDBOX_PIDS_LIMIT: '128',
    };
    assert.deepEqual(resolveSandboxResourceLimits({}, env), { memoryMb: 768, cpus: 2, pidsLimit: 128 });
  });

  it('lets a valid setting win over env, and an invalid setting fall through to env', () => {
    const env = { OMADIA_SANDBOX_MEMORY_MB: '768', OMADIA_SANDBOX_CPUS: '2', OMADIA_SANDBOX_PIDS_LIMIT: 'lots' };
    assert.deepEqual(resolveSandboxResourceLimits({ memoryMb: 1024, cpus: 0, pidsLimit: '' }, env), {
      memoryMb: 1024,
      cpus: 2,
      pidsLimit: DEFAULT_SANDBOX_RESOURCE_LIMITS.pidsLimit,
    });
  });

  it('reads process.env when no env is passed', () => {
    const saved = process.env['OMADIA_SANDBOX_PIDS_LIMIT'];
    process.env['OMADIA_SANDBOX_PIDS_LIMIT'] = '99';
    try {
      assert.equal(resolveSandboxResourceLimits().pidsLimit, 99);
    } finally {
      if (saved === undefined) delete process.env['OMADIA_SANDBOX_PIDS_LIMIT'];
      else process.env['OMADIA_SANDBOX_PIDS_LIMIT'] = saved;
    }
  });
});

describe('dockerResourceLimitArgs', () => {
  it('yields the exact flags for the defaults, with swap capped at the memory limit', () => {
    assert.deepEqual(dockerResourceLimitArgs(DEFAULT_SANDBOX_RESOURCE_LIMITS), [
      '--memory',
      '512m',
      '--memory-swap',
      '512m',
      '--cpus',
      '1',
      '--pids-limit',
      '256',
    ]);
  });

  it('renders overrides verbatim', () => {
    assert.deepEqual(dockerResourceLimitArgs({ memoryMb: 2048, cpus: 0.5, pidsLimit: 64 }), [
      '--memory',
      '2048m',
      '--memory-swap',
      '2048m',
      '--cpus',
      '0.5',
      '--pids-limit',
      '64',
    ]);
  });

  it('never emits a 0 that Docker would read as "unlimited", even from a hand-built object', () => {
    const args = dockerResourceLimitArgs({ memoryMb: 0, cpus: 0, pidsLimit: 0 });
    assert.ok(!args.includes('0') && !args.includes('0m'), `got ${JSON.stringify(args)}`);
    assert.equal(args.length, 8);
  });
});
