import { describe, it, after, afterEach, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

import { DockerSandboxBackend, _internal, type DockerSandboxBackendOptions } from '../../packages/harness-sandbox/src/dockerSandbox.js';
import { resolveAgentComputerProfile } from '../../packages/harness-sandbox/src/agentComputerProfile.js';
import type { DockerExec, DockerExecContext, DockerExecResult } from '../../packages/harness-sandbox/src/dockerExec.js';
import type { Sandbox } from '../../packages/harness-sandbox/src/sandbox.js';
import {
  NO_LIMITS,
  inspectOutput,
  withInspectableLimits,
  type InspectedLimits,
} from '../_helpers/dockerInspectStub.js';

/**
 * Resource ceilings of `DockerSandboxBackend` (see `resourceLimits.ts`), with
 * the same two tiers as `dockerSandbox.test.ts`:
 *
 *  - STUB tier (always runs): the limit flags on the `docker run` and
 *    `docker update` argv, their position before the image, the
 *    update-before-start order on re-attach, and that a container whose
 *    limits `docker inspect` does not show in force runs nothing.
 *  - REAL-DOCKER tier (`SANDBOX_DOCKER_TEST=1`, opt-in): what the daemon
 *    recorded (`docker inspect`), the CPU quota the kernel enforces
 *    (`cpu.max`, cgroup v2), that the memory ceiling really kills an
 *    oversized allocation, and that a container the daemon cannot update is
 *    refused.
 */

interface RecordedCall {
  readonly args: readonly string[];
  readonly input: string | undefined;
}

/** `inspect` defaults to a daemon that applied the flags of the last
 *  successful `run` or `update` (`dockerInspectStub.ts`). */
function stubExec(
  script: (ctx: DockerExecContext, callIndex: number) => DockerExecResult,
  inspect?: (applied: InspectedLimits) => DockerExecResult,
): { exec: DockerExec; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const answer = withInspectableLimits(script, inspect);
  const exec: DockerExec = async (ctx) => {
    calls.push({ args: ctx.args, input: ctx.input });
    return answer(ctx, calls.length - 1);
  };
  return { exec, calls };
}

function ok(stdout = '', stderr = ''): DockerExecResult {
  return { exitCode: 0, stdout, stderr, timedOut: false, outputTruncated: false };
}
function fail(stderr: string, exitCode = 1): DockerExecResult {
  return { exitCode, stdout: '', stderr, timedOut: false, outputTruncated: false };
}

// Resource ceilings are WIRED the same way egress is: asserted on the argv the
// backend hands Docker, and (real tier below) on what the daemon applied.
const LIMIT_ENV_KEYS = ['OMADIA_SANDBOX_MEMORY_MB', 'OMADIA_SANDBOX_CPUS', 'OMADIA_SANDBOX_PIDS_LIMIT'] as const;
const TEST_IMAGE = 'sandbox-test-image:1';

/** Save and clear the limit env variables so a developer's shell cannot leak into a default. */
function isolateLimitEnv(): void {
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
}

/** The value following `flag`, asserting the pair sits before the image. */
function flagBeforeImage(args: readonly string[], flag: string): string {
  const flagIndex = args.indexOf(flag);
  const imageIndex = args.indexOf(TEST_IMAGE);
  assert.ok(flagIndex >= 0, `expected ${flag} in argv, got: ${JSON.stringify(args)}`);
  assert.ok(flagIndex < imageIndex, `${flag} must come before the image (a flag after it is an argument to the container command)`);
  return args[flagIndex + 1]!;
}

async function provisionFresh(options: Omit<DockerSandboxBackendOptions, 'execDocker' | 'image'> = {}) {
  const { exec, calls } = stubExec((ctx) => (ctx.args[0] === 'ps' ? ok('') : ok()));
  const backend = new DockerSandboxBackend({ ...options, execDocker: exec, image: TEST_IMAGE });
  await backend.provision({ scopeKey: 'personal:limits', profile: resolveAgentComputerProfile() });
  const runCall = calls.find((c) => c.args[0] === 'run');
  assert.ok(runCall, 'expected a `docker run` invocation');
  return runCall.args;
}

describe('DockerSandboxBackend.provision — resource limits (stub)', () => {
  isolateLimitEnv();

  it('caps memory (swap included), CPU and PIDs on the docker run argv by default', async () => {
    const args = await provisionFresh();
    assert.equal(flagBeforeImage(args, '--memory'), '512m');
    assert.equal(flagBeforeImage(args, '--memory-swap'), '512m');
    assert.equal(flagBeforeImage(args, '--cpus'), '1');
    assert.equal(flagBeforeImage(args, '--pids-limit'), '256');
  });

  it('reflects resourceLimits overrides', async () => {
    const args = await provisionFresh({ resourceLimits: { memoryMb: 2048, cpus: 0.5, pidsLimit: 64 } });
    assert.equal(flagBeforeImage(args, '--memory'), '2048m');
    assert.equal(flagBeforeImage(args, '--memory-swap'), '2048m');
    assert.equal(flagBeforeImage(args, '--cpus'), '0.5');
    assert.equal(flagBeforeImage(args, '--pids-limit'), '64');
  });

  it('falls back to the defaults for invalid overrides — the flags are never dropped', async () => {
    const args = await provisionFresh({ resourceLimits: { memoryMb: 0, cpus: -1, pidsLimit: Number.NaN } });
    assert.equal(flagBeforeImage(args, '--memory'), '512m');
    assert.equal(flagBeforeImage(args, '--cpus'), '1');
    assert.equal(flagBeforeImage(args, '--pids-limit'), '256');
  });

  it('takes a limit the options leave out from its OMADIA_SANDBOX_* env variable', async () => {
    process.env['OMADIA_SANDBOX_MEMORY_MB'] = '768';
    const args = await provisionFresh({ resourceLimits: { pidsLimit: 64 } });
    assert.equal(flagBeforeImage(args, '--memory'), '768m');
    assert.equal(flagBeforeImage(args, '--pids-limit'), '64');
    assert.equal(flagBeforeImage(args, '--cpus'), '1');
  });

  it('re-attach applies the current limits with docker update before docker start', async () => {
    const name = _internal.containerNameFor('personal:limits-reattach');
    const { exec, calls } = stubExec((ctx) => (ctx.args[0] === 'ps' ? ok(name) : ok()));
    const backend = new DockerSandboxBackend({ execDocker: exec, resourceLimits: { memoryMb: 1024 } });
    await backend.provision({ scopeKey: 'personal:limits-reattach', profile: resolveAgentComputerProfile() });

    const verbs = calls.map((c) => c.args[0]);
    assert.ok(verbs.indexOf('update') >= 0, `expected docker update, got: ${JSON.stringify(verbs)}`);
    assert.ok(verbs.indexOf('update') < verbs.indexOf('start'), 'update must run before start');
    assert.deepEqual(calls[verbs.indexOf('update')]!.args, [
      'update',
      '--memory',
      '1024m',
      '--memory-swap',
      '1024m',
      '--cpus',
      '1',
      '--pids-limit',
      '256',
      name,
    ]);
  });

  it('re-attach checks the limits with docker inspect after the update and before docker start', async () => {
    const name = _internal.containerNameFor('personal:limits-verified');
    const { exec, calls } = stubExec((ctx) => (ctx.args[0] === 'ps' ? ok(name) : ok()));
    const logged: string[] = [];
    const backend = new DockerSandboxBackend({ execDocker: exec, log: (msg) => logged.push(msg) });
    const sandbox = await backend.provision({ scopeKey: 'personal:limits-verified', profile: resolveAgentComputerProfile() });

    assert.equal(sandbox.id, name);
    assert.deepEqual(
      calls.map((c) => c.args[0]),
      ['ps', 'update', 'inspect', 'start'],
      'nothing is stopped or removed when the limits hold',
    );
    assert.deepEqual(calls[2]!.args, ['inspect', '--type', 'container', '--format', '{{json .HostConfig}}', name]);
    assert.deepEqual(logged, []);
  });

  it('a new container is checked with docker inspect too', async () => {
    const { exec, calls } = stubExec((ctx) => (ctx.args[0] === 'ps' ? ok('') : ok()));
    await new DockerSandboxBackend({ execDocker: exec }).provision({
      scopeKey: 'personal:limits-new-verified',
      profile: resolveAgentComputerProfile(),
    });
    assert.deepEqual(calls.map((c) => c.args[0]), ['ps', 'run', 'inspect']);
  });

  it('a failing docker update on re-attach refuses the container: it is stopped and kept, never started', async () => {
    const scopeKey = 'personal:limits-update-fails';
    const name = _internal.containerNameFor(scopeKey);
    let updateWorks = false;
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok(name);
      if (ctx.args[0] === 'update' && !updateWorks) return fail('Error response from daemon: Cannot update container');
      return ok();
    });
    const logged: string[] = [];
    const backend = new DockerSandboxBackend({ execDocker: exec, log: (msg) => logged.push(msg) });

    await assert.rejects(backend.provision({ scopeKey, profile: resolveAgentComputerProfile() }), (err: Error) => {
      assert.match(err.message, /resource limits are not in force \(docker update failed \(exit 1\)\)/);
      assert.match(err.message, /stopped and kept with its files/);
      assert.ok(!err.message.includes('Cannot update container'), 'Docker output stays out of the error');
      return true;
    });
    const verbs = calls.map((c) => c.args[0]);
    assert.deepEqual(verbs, ['ps', 'update', 'stop'], 'never started, never exec-ed into, never removed');
    assert.deepEqual(calls[2]!.args, ['stop', '-t', '0', name]);
    assert.equal(logged.length, 1);
    assert.ok(logged[0]!.includes(name));
    assert.match(logged[0]!, /docker update failed \(exit 1\).*stopped and kept/);
    assert.ok(!logged[0]!.includes('Cannot update container'), 'Docker output stays out of the log');

    // The refusal is not cached: once the daemon takes the update, the same
    // backend re-attaches the kept container.
    updateWorks = true;
    const sandbox = await backend.provision({ scopeKey, profile: resolveAgentComputerProfile() });
    assert.equal(sandbox.id, name);
    assert.deepEqual(calls.slice(3).map((c) => c.args[0]), ['ps', 'update', 'inspect', 'start']);
  });

  it('a docker update that throws refuses the container as well', async () => {
    const name = _internal.containerNameFor('personal:limits-update-throws');
    const calls: string[] = [];
    const exec: DockerExec = async (ctx) => {
      calls.push(ctx.args[0]!);
      if (ctx.args[0] === 'ps') return ok(name);
      if (ctx.args[0] === 'update') throw new Error('spawn docker ENOENT');
      return ok();
    };
    const logged: string[] = [];
    await assert.rejects(
      new DockerSandboxBackend({ execDocker: exec, log: (msg) => logged.push(msg) }).provision({
        scopeKey: 'personal:limits-update-throws',
        profile: resolveAgentComputerProfile(),
      }),
      /docker update could not run/,
    );
    assert.deepEqual(calls, ['ps', 'update', 'stop']);
    assert.ok(!logged.join('\n').includes('ENOENT'));
  });

  describe('an existing container whose docker inspect shows a missing or looser limit after the update runs nothing', () => {
    const cases: ReadonlyArray<readonly [string, (applied: InspectedLimits) => InspectedLimits, RegExp]> = [
      ['no limits at all', () => NO_LIMITS, /--memory not set \(required 536870912 bytes\); --memory-swap not set.*--cpus not set.*--pids-limit not set/],
      ['unlimited swap', (applied) => ({ ...applied, MemorySwap: -1 }), /--memory-swap not set \(required 536870912 bytes\)/],
      ['twice the memory', (applied) => ({ ...applied, Memory: 1073741824, MemorySwap: 1073741824 }), /--memory 1073741824 bytes \(required at most 536870912\)/],
      ['twice the CPU share', (applied) => ({ ...applied, NanoCpus: 2_000_000_000 }), /--cpus 2000000000 nano-CPUs \(required at most 1000000000\)/],
      ['a CFS quota of two CPUs', (applied) => ({ ...applied, NanoCpus: 0, CpuQuota: 200_000, CpuPeriod: 100_000 }), /--cpus 2000000000 nano-CPUs/],
      ['no PID limit', (applied) => ({ ...applied, PidsLimit: null }), /--pids-limit not set \(required 256 processes\)/],
      ['PID limit -1', (applied) => ({ ...applied, PidsLimit: -1 }), /--pids-limit not set/],
    ];
    for (const [label, inspected, expected] of cases) {
      it(label, async () => {
        const scopeKey = `personal:limits-weaker-${label}`;
        const name = _internal.containerNameFor(scopeKey);
        const { exec, calls } = stubExec(
          (ctx) => (ctx.args[0] === 'ps' ? ok(name) : ok()),
          (applied) => inspectOutput(inspected(applied)),
        );
        const logged: string[] = [];
        const backend = new DockerSandboxBackend({ execDocker: exec, log: (msg) => logged.push(msg) });
        await assert.rejects(backend.provision({ scopeKey, profile: resolveAgentComputerProfile() }), expected);
        assert.deepEqual(calls.map((c) => c.args[0]), ['ps', 'update', 'inspect', 'stop']);
        assert.equal(logged.length, 1);
        assert.match(logged[0]!, expected);
      });
    }
  });

  it('a stricter limit than required counts as in force', async () => {
    const name = _internal.containerNameFor('personal:limits-stricter');
    const { exec, calls } = stubExec(
      (ctx) => (ctx.args[0] === 'ps' ? ok(name) : ok()),
      (applied) => inspectOutput({ ...applied, Memory: 268435456, MemorySwap: 268435456, PidsLimit: 64 }),
    );
    await new DockerSandboxBackend({ execDocker: exec }).provision({
      scopeKey: 'personal:limits-stricter',
      profile: resolveAgentComputerProfile(),
    });
    assert.deepEqual(calls.map((c) => c.args[0]), ['ps', 'update', 'inspect', 'start']);
  });

  it('a new container the daemon started without a limit is removed and runs nothing', async () => {
    const scopeKey = 'personal:limits-new-dropped';
    const name = _internal.containerNameFor(scopeKey);
    const { exec, calls } = stubExec(
      (ctx) => (ctx.args[0] === 'ps' ? ok('') : ok()),
      // What a kernel without the pids controller leaves: `docker run` exits 0
      // with a warning and records no PID limit.
      (applied) => inspectOutput({ ...applied, PidsLimit: null }),
    );
    const logged: string[] = [];
    const backend = new DockerSandboxBackend({ execDocker: exec, log: (msg) => logged.push(msg) });
    await assert.rejects(backend.provision({ scopeKey, profile: resolveAgentComputerProfile() }), (err: Error) => {
      assert.match(err.message, /daemon did not apply its resource limits \(--pids-limit not set \(required 256 processes\)\)/);
      assert.match(err.message, /Nothing ran in it/);
      return true;
    });
    assert.deepEqual(calls.map((c) => c.args[0]), ['ps', 'run', 'inspect', 'rm']);
    assert.deepEqual(calls[3]!.args, ['rm', '-f', name]);
    assert.match(logged[0]!, /it was removed$/);
  });

  it('a failing or unreadable docker inspect counts as limits not in force', async () => {
    const failures: ReadonlyArray<readonly [DockerExecResult, RegExp]> = [
      [fail('Error: No such object'), /docker inspect failed \(exit 1\)/],
      [{ exitCode: null, stdout: '', stderr: '', timedOut: true, outputTruncated: false }, /docker inspect timed out/],
      [ok('<no value>'), /docker inspect returned no readable HostConfig/],
    ];
    for (const [result, expected] of failures) {
      const { exec, calls } = stubExec((ctx) => (ctx.args[0] === 'ps' ? ok('') : ok()), () => result);
      await assert.rejects(
        new DockerSandboxBackend({ execDocker: exec, log: () => undefined }).provision({
          scopeKey: 'personal:limits-inspect-fails',
          profile: resolveAgentComputerProfile(),
        }),
        (err: Error) => {
          assert.match(err.message, expected);
          assert.ok(!err.message.includes('No such object'), 'Docker output stays out of the error');
          return true;
        },
      );
      assert.deepEqual(calls.map((c) => c.args[0]), ['ps', 'run', 'inspect', 'rm']);
    }
  });

  it('a failed stop is reported, and the container still runs nothing', async () => {
    const name = _internal.containerNameFor('personal:limits-stop-fails');
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok(name);
      if (ctx.args[0] === 'update') return fail('update refused');
      if (ctx.args[0] === 'stop') return fail('stop refused');
      return ok();
    });
    const logged: string[] = [];
    await assert.rejects(
      new DockerSandboxBackend({ execDocker: exec, log: (msg) => logged.push(msg) }).provision({
        scopeKey: 'personal:limits-stop-fails',
        profile: resolveAgentComputerProfile(),
      }),
      /Stopping it failed/,
    );
    assert.deepEqual(calls.map((c) => c.args[0]), ['ps', 'update', 'stop']);
    assert.deepEqual(logged, [
      `[sandbox] docker stop failed (exit 1) for '${name}'`,
      `[sandbox] container '${name}' runs nothing: its resource limits are not in force (docker update failed (exit 1)); stopping it failed`,
    ]);
  });

  it('a CPU or memory value Docker would apply as no limit reaches neither docker run nor docker update', async () => {
    for (const cpus of [0.000001, 1e-7, 1e64]) {
      const args = await provisionFresh({ resourceLimits: { cpus, memoryMb: 1e21 } });
      assert.equal(flagBeforeImage(args, '--cpus'), '1', `cpus ${String(cpus)} must fall back to the default`);
      assert.equal(flagBeforeImage(args, '--memory'), '512m');
    }

    const name = _internal.containerNameFor('personal:limits-out-of-range');
    const { exec, calls } = stubExec((ctx) => (ctx.args[0] === 'ps' ? ok(name) : ok()));
    const backend = new DockerSandboxBackend({ execDocker: exec, resourceLimits: { cpus: 1e-7, memoryMb: 8796093022208 } });
    await backend.provision({ scopeKey: 'personal:limits-out-of-range', profile: resolveAgentComputerProfile() });
    assert.deepEqual(calls.find((c) => c.args[0] === 'update')?.args, [
      'update',
      '--memory',
      '512m',
      '--memory-swap',
      '512m',
      '--cpus',
      '1',
      '--pids-limit',
      '256',
      name,
    ]);
  });
});

// ---------------------------------------------------------------------------
// REAL-DOCKER tier — opt-in, gated on SANDBOX_DOCKER_TEST=1 like the one in
// dockerSandbox.test.ts: proves the daemon applied the ceilings, not just
// that the stub tier saw the flags.
// ---------------------------------------------------------------------------
const DOCKER_TEST_ENABLED = process.env['SANDBOX_DOCKER_TEST'] === '1';
const describeIfDocker = DOCKER_TEST_ENABLED ? describe : describe.skip;

/** Memory, swap ceiling, NanoCPUs and PID limit as the daemon recorded them. */
function inspectLimits(name: string): string {
  return execFileSync('docker', [
    'inspect',
    '--format',
    '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}',
    name,
  ])
    .toString()
    .trim();
}

const DEFAULT_LIMITS_INSPECTED = '536870912 536870912 1000000000 256';

/** The CFS quota the kernel enforces: `<quota µs | max> <period µs>` (cgroup v2). */
async function cpuMax(sandbox: Sandbox): Promise<string> {
  const result = await sandbox.run('cat /sys/fs/cgroup/cpu.max');
  assert.equal(result.exitCode, 0, `cpu.max unreadable (this tier expects cgroup v2): ${result.stderr}`);
  return result.stdout.trim();
}

describeIfDocker('DockerSandboxBackend — resource limits on a real daemon (SANDBOX_DOCKER_TEST=1)', () => {
  isolateLimitEnv();
  const cleanup: string[] = [];
  after(() => {
    for (const name of cleanup) {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('the daemon applies the default ceilings, not just the argv', async () => {
    const sandbox = await new DockerSandboxBackend().provision({
      scopeKey: `personal:limits-real-${String(Date.now())}`,
      profile: resolveAgentComputerProfile(),
    });
    cleanup.push(sandbox.id);
    assert.equal(inspectLimits(sandbox.id), DEFAULT_LIMITS_INSPECTED);
  });

  it('the memory ceiling is enforced: 700 MB cannot be allocated, 100 MB can', async () => {
    const sandbox = await new DockerSandboxBackend().provision({
      scopeKey: `personal:limits-oom-${String(Date.now())}`,
      profile: resolveAgentComputerProfile({ maxRunSeconds: 60 }),
    });
    cleanup.push(sandbox.id);

    const allocate = (bytes: number) =>
      sandbox.run(`awk 'BEGIN { s = sprintf("%${String(bytes)}s", ""); print length(s) }'`);
    const small = await allocate(100_000_000);
    assert.equal(small.stdout.trim(), '100000000', 'positive control: a 100 MB string fits');
    const large = await allocate(700_000_000);
    assert.notEqual(large.exitCode, 0, 'the 700 MB allocation must be killed, swap included');
    assert.ok(!large.stdout.includes('700000000'));
  });

  it('re-attach puts the ceilings on a container created without them', async () => {
    const scopeKey = `personal:limits-legacy-${String(Date.now())}`;
    const name = _internal.containerNameFor(scopeKey);
    execFileSync('docker', ['run', '-d', '--name', name, 'alpine:3.20', 'sleep', 'infinity'], { stdio: 'ignore' });
    cleanup.push(name);
    assert.equal(inspectLimits(name).split(' ')[0], '0', 'precondition: no memory limit');

    await new DockerSandboxBackend().provision({ scopeKey, profile: resolveAgentComputerProfile() });
    assert.equal(inspectLimits(name), DEFAULT_LIMITS_INSPECTED);
  });

  it('re-attach can raise the memory ceiling, because swap is updated with it', async () => {
    const scopeKey = `personal:limits-raise-${String(Date.now())}`;
    const profile = resolveAgentComputerProfile();
    const sandbox = await new DockerSandboxBackend().provision({ scopeKey, profile });
    cleanup.push(sandbox.id);

    await new DockerSandboxBackend({ resourceLimits: { memoryMb: 1024 } }).provision({ scopeKey, profile });
    assert.equal(inspectLimits(sandbox.id), '1073741824 1073741824 1000000000 256');
  });

  it('re-attach refuses a container the daemon cannot update: it is stopped, kept, and gets no limits', async () => {
    const scopeKey = `personal:limits-refused-${String(Date.now())}`;
    const name = _internal.containerNameFor(scopeKey);
    // A CPU share set as a CFS quota makes `docker update --cpus` fail
    // ("Conflicting options"), so the update cannot bring this one up to date.
    execFileSync('docker', ['run', '-d', '--name', name, '--cpu-quota', '50000', 'alpine:3.20', 'sleep', 'infinity'], {
      stdio: 'ignore',
    });
    cleanup.push(name);

    await assert.rejects(
      new DockerSandboxBackend({ log: () => undefined }).provision({ scopeKey, profile: resolveAgentComputerProfile() }),
      /resource limits are not in force \(docker update failed/,
    );
    const running = execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', name]).toString().trim();
    assert.equal(running, 'false', 'the container is stopped, not removed');
    assert.equal(inspectLimits(name).split(' ')[0], '0', 'it still has no memory limit');
  });

  it('a fractional CPU share becomes a real CFS quota', async () => {
    const sandbox = await new DockerSandboxBackend({ resourceLimits: { cpus: 0.5 } }).provision({
      scopeKey: `personal:limits-cpu-half-${String(Date.now())}`,
      profile: resolveAgentComputerProfile(),
    });
    cleanup.push(sandbox.id);
    assert.equal(inspectLimits(sandbox.id).split(' ')[2], '500000000');
    assert.equal(await cpuMax(sandbox), '50000 100000');
  });

  it('a CPU value Docker would run without a quota gets the default quota instead', async () => {
    for (const cpus of [0.000001, 1e-7, 1e64]) {
      const sandbox = await new DockerSandboxBackend({ resourceLimits: { cpus } }).provision({
        scopeKey: `personal:limits-cpu-${String(cpus)}-${String(Date.now())}`,
        profile: resolveAgentComputerProfile(),
      });
      cleanup.push(sandbox.id);
      assert.equal(await cpuMax(sandbox), '100000 100000', `cpus ${String(cpus)} must not leave the container without a quota`);
    }
  });

  it('a memory value Docker would record as no limit gets the default ceiling instead', async () => {
    const sandbox = await new DockerSandboxBackend({ resourceLimits: { memoryMb: 1e21 } }).provision({
      scopeKey: `personal:limits-mem-huge-${String(Date.now())}`,
      profile: resolveAgentComputerProfile(),
    });
    cleanup.push(sandbox.id);
    assert.equal(inspectLimits(sandbox.id), DEFAULT_LIMITS_INSPECTED);
  });
});
