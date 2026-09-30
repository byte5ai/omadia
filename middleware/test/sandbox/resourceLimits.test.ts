import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  SANDBOX_RESOURCE_LIMIT_BOUNDS,
  SANDBOX_RESOURCE_LIMIT_ENV_KEYS,
  dockerResourceLimitArgs,
  resolveSandboxResourceLimits,
  type SandboxResourceLimits,
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

/**
 * Positive numbers that are still not a ceiling Docker applies. Each one used
 * to reach argv. Behaviour reproduced on Docker 29.4 (arm64, cgroup v2).
 */
const OUT_OF_RANGE: ReadonlyArray<{ field: keyof SandboxResourceLimits; value: number | string; docker: string }> = [
  { field: 'cpus', value: 0.000001, docker: 'quota truncates to 0, cpu.max "max"' },
  { field: 'cpus', value: 0.000009, docker: 'quota truncates to 0, cpu.max "max"' },
  { field: 'cpus', value: 1e-7, docker: 'renders as 1e-7, cpu.max "max"' },
  { field: 'cpus', value: '1e-7', docker: 'cpu.max "max"' },
  { field: 'cpus', value: 1e64, docker: 'nano-CPU count wraps to 0, cpu.max "max"' },
  { field: 'cpus', value: '1e64', docker: 'cpu.max "max"' },
  { field: 'cpus', value: 0.009, docker: 'kernel refuses a sub-millisecond quota' },
  { field: 'cpus', value: 1025, docker: 'above the cap' },
  { field: 'memoryMb', value: 1e21, docker: 'renders as 1e+21m, recorded as no limit' },
  { field: 'memoryMb', value: '1e21', docker: 'recorded as no limit' },
  { field: 'memoryMb', value: 8796093022208, docker: '2^43 MiB overflows int64, recorded as no limit' },
  { field: 'memoryMb', value: 1048577, docker: 'above the 1 TiB cap' },
  { field: 'memoryMb', value: 5, docker: 'Docker refuses less than 6 MiB' },
  { field: 'pidsLimit', value: 4194305, docker: 'pids.max refuses more than 4194304' },
  { field: 'pidsLimit', value: 1e21, docker: 'renders as 1e+21, which docker run refuses' },
];

describe('resolveSandboxResourceLimits — only values Docker applies as a real ceiling', () => {
  it('pins the documented ranges', () => {
    assert.deepEqual(SANDBOX_RESOURCE_LIMIT_BOUNDS, {
      memoryMb: { min: 6, max: 1048576 },
      cpus: { min: 0.01, max: 1024 },
      pidsLimit: { min: 1, max: 4194304 },
    });
    assert.ok(Object.isFrozen(SANDBOX_RESOURCE_LIMIT_BOUNDS));
    assert.ok(Object.values(SANDBOX_RESOURCE_LIMIT_BOUNDS).every((range) => Object.isFrozen(range)));
  });

  for (const { field, value, docker } of OUT_OF_RANGE) {
    const label = typeof value === 'string' ? JSON.stringify(value) : String(value);
    it(`${field} ${label} falls back to the default (${docker})`, () => {
      assert.equal(resolveSandboxResourceLimits({ [field]: value }, NO_ENV)[field], DEFAULT_SANDBOX_RESOURCE_LIMITS[field]);
    });
  }

  it('accepts both ends of every range', () => {
    assert.deepEqual(resolveSandboxResourceLimits({ memoryMb: 6, cpus: 0.01, pidsLimit: 1 }, NO_ENV), {
      memoryMb: 6,
      cpus: 0.01,
      pidsLimit: 1,
    });
    assert.deepEqual(resolveSandboxResourceLimits({ memoryMb: '1048576', cpus: '1024', pidsLimit: '4194304' }, NO_ENV), {
      memoryMb: 1048576,
      cpus: 1024,
      pidsLimit: 4194304,
    });
  });

  it('an out-of-range env value falls back to the default as well', () => {
    const env = { OMADIA_SANDBOX_MEMORY_MB: '1e21', OMADIA_SANDBOX_CPUS: '0.000001', OMADIA_SANDBOX_PIDS_LIMIT: '4194305' };
    assert.deepEqual(resolveSandboxResourceLimits({}, env), DEFAULT_SANDBOX_RESOURCE_LIMITS);
  });

  it('an out-of-range setting falls through to a valid env value', () => {
    assert.equal(resolveSandboxResourceLimits({ cpus: 1e-7 }, { OMADIA_SANDBOX_CPUS: '2' }).cpus, 2);
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

  describe('values Docker would apply as no limit', () => {
    const LIMIT_ENV_KEYS = Object.values(SANDBOX_RESOURCE_LIMIT_ENV_KEYS);
    const saved = new Map<string, string | undefined>();
    beforeEach(() => {
      for (const key of LIMIT_ENV_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
      }
    });
    afterEach(() => {
      for (const key of LIMIT_ENV_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const DEFAULT_ARGS = ['--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '256'];

    it('are replaced by the defaults, even in a hand-built object', () => {
      assert.deepEqual(dockerResourceLimitArgs({ memoryMb: 512, cpus: 0.000001, pidsLimit: 256 }), DEFAULT_ARGS);
      assert.deepEqual(dockerResourceLimitArgs({ memoryMb: 1e21, cpus: 1e-7, pidsLimit: 1e21 }), DEFAULT_ARGS);
      assert.deepEqual(dockerResourceLimitArgs({ memoryMb: 8796093022208, cpus: 1e64, pidsLimit: 4194305 }), DEFAULT_ARGS);
    });

    it('never render in exponent notation: the range ends stay plain digits', () => {
      assert.deepEqual(dockerResourceLimitArgs({ memoryMb: 1048576, cpus: 0.01, pidsLimit: 4194304 }), [
        '--memory',
        '1048576m',
        '--memory-swap',
        '1048576m',
        '--cpus',
        '0.01',
        '--pids-limit',
        '4194304',
      ]);
    });
  });
});
