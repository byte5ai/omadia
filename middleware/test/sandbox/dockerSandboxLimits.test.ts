import { describe, it, after, afterEach, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

import { DockerSandboxBackend, _internal, type DockerSandboxBackendOptions } from '../../packages/harness-sandbox/src/dockerSandbox.js';
import { resolveAgentComputerProfile } from '../../packages/harness-sandbox/src/agentComputerProfile.js';
import type { DockerExec, DockerExecContext, DockerExecResult } from '../../packages/harness-sandbox/src/dockerExec.js';
import type { Sandbox } from '../../packages/harness-sandbox/src/sandbox.js';

/**
 * Resource ceilings of `DockerSandboxBackend` (see `resourceLimits.ts`), with
 * the same two tiers as `dockerSandbox.test.ts`:
 *
 *  - STUB tier (always runs): the limit flags on the `docker run` and
 *    `docker update` argv, their position before the image, and the
 *    update-before-start order on re-attach.
 *  - REAL-DOCKER tier (`SANDBOX_DOCKER_TEST=1`, opt-in): what the daemon
 *    recorded (`docker inspect`), the CPU quota the kernel enforces
 *    (`cpu.max`, cgroup v2) and that the memory ceiling really kills an
 *    oversized allocation.
 */

interface RecordedCall {
  readonly args: readonly string[];
  readonly input: string | undefined;
}

function stubExec(
  script: (ctx: DockerExecContext, callIndex: number) => DockerExecResult,
): { exec: DockerExec; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: DockerExec = async (ctx) => {
    calls.push({ args: ctx.args, input: ctx.input });
    return script(ctx, calls.length - 1);
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

  it('a failing docker update on re-attach is logged and the container still starts', async () => {
    const name = _internal.containerNameFor('personal:limits-update-fails');
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok(name);
      if (ctx.args[0] === 'update') return fail('Error response from daemon: Cannot update container');
      return ok();
    });
    const logged: string[] = [];
    const backend = new DockerSandboxBackend({ execDocker: exec, log: (msg) => logged.push(msg) });
    const sandbox = await backend.provision({ scopeKey: 'personal:limits-update-fails', profile: resolveAgentComputerProfile() });

    assert.equal(sandbox.id, name);
    assert.ok(calls.some((c) => c.args[0] === 'start'), 'the container must still be started');
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /docker update/);
    assert.ok(logged[0]!.includes(name));
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
