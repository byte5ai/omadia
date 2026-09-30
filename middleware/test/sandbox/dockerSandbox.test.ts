import { describe, it, after, afterEach, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

import { DockerSandboxBackend, _internal, type DockerSandboxBackendOptions } from '../../packages/harness-sandbox/src/dockerSandbox.js';
import { resolveAgentComputerProfile } from '../../packages/harness-sandbox/src/agentComputerProfile.js';
import type { DockerExec, DockerExecContext, DockerExecResult } from '../../packages/harness-sandbox/src/dockerExec.js';

/**
 * #576 P1 — DockerSandboxBackend tests.
 *
 * Two tiers, same split the plan requires ("Docker-Tests hinter ein Gate;
 * Stub-Tests decken die Logik"):
 *
 *  - STUB tier (always runs, no Docker needed): a canned `execDocker`
 *    records every invocation's argv/input and returns scripted results, so
 *    every branch of provision/run/read/write/list/teardown — including the
 *    AgentComputerProfile → argv translation that IS the wiring proof for
 *    `egress` — is exercised deterministically in CI.
 *  - REAL-DOCKER tier (`SANDBOX_DOCKER_TEST=1`, opt-in): an actual
 *    container proves the stub's assumption is true — most importantly that
 *    `--network none` really does block an outbound request, not just that
 *    the flag was passed.
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

describe('DockerSandboxBackend.provision — AgentComputerProfile wiring (stub)', () => {
  it('egress:false becomes "--network none" on the docker run argv', async () => {
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok(''); // container does not exist yet
      return ok(); // `run`
    });
    const backend = new DockerSandboxBackend({ execDocker: exec });
    await backend.provision({
      scopeKey: 'personal:egress-off',
      profile: resolveAgentComputerProfile({ egress: false }),
    });
    const runCall = calls.find((c) => c.args[0] === 'run');
    assert.ok(runCall, 'expected a `docker run` invocation');
    assert.ok(
      runCall!.args.includes('--network') && runCall!.args.includes('none'),
      `expected --network none in argv, got: ${JSON.stringify(runCall!.args)}`,
    );
  });

  it('egress:true does NOT pass --network none — the sandbox keeps its default (bridge) network', async () => {
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok('');
      return ok();
    });
    const backend = new DockerSandboxBackend({ execDocker: exec });
    await backend.provision({
      scopeKey: 'personal:egress-on',
      profile: resolveAgentComputerProfile({ egress: true }),
    });
    const runCall = calls.find((c) => c.args[0] === 'run');
    assert.ok(runCall);
    assert.ok(!runCall!.args.includes('none'), `did not expect --network none, got: ${JSON.stringify(runCall!.args)}`);
  });

  it('provision() is idempotent per live scope: a second call for the same scopeKey does not run a second container', async () => {
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok('');
      return ok();
    });
    const backend = new DockerSandboxBackend({ execDocker: exec });
    const profile = resolveAgentComputerProfile();
    const a = await backend.provision({ scopeKey: 'personal:reuse', profile });
    const b = await backend.provision({ scopeKey: 'personal:reuse', profile });
    assert.equal(a, b, 'expected the same Sandbox instance back');
    assert.equal(calls.filter((c) => c.args[0] === 'run').length, 1);
  });

  it('provision() re-attaches (docker start) rather than re-running when the container already exists', async () => {
    const name = _internal.containerNameFor('personal:existing');
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok(name);
      return ok();
    });
    const backend = new DockerSandboxBackend({ execDocker: exec });
    await backend.provision({ scopeKey: 'personal:existing', profile: resolveAgentComputerProfile() });
    assert.ok(calls.some((c) => c.args[0] === 'start'));
    assert.ok(!calls.some((c) => c.args[0] === 'run'), 'must not re-run an already-existing container');
  });

  it('the container name is deterministic per scope key, so a fresh backend instance re-attaches to the same container', () => {
    const a = _internal.containerNameFor('personal:stable-scope');
    const b = _internal.containerNameFor('personal:stable-scope');
    const c = _internal.containerNameFor('personal:other-scope');
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

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
});

describe('DockerSandbox.run', () => {
  it('wraps the command with the profile\'s maxRunSeconds via `timeout`, and passes cwd/env', async () => {
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok('');
      if (ctx.args[0] === 'run') return ok();
      return ok('hello\n');
    });
    const backend = new DockerSandboxBackend({ execDocker: exec });
    const sandbox = await backend.provision({
      scopeKey: 'personal:run-test',
      profile: resolveAgentComputerProfile({ maxRunSeconds: 5 }),
    });
    const result = await sandbox.run('echo hello', { env: { FOO: 'bar' } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hello\n');
    const execCall = calls[calls.length - 1]!;
    assert.deepEqual(execCall.args.slice(0, 2), ['exec', '-e']);
    assert.ok(execCall.args.includes('FOO=bar'));
    assert.ok(execCall.args.includes('timeout'));
    assert.ok(execCall.args.includes('5s'));
    assert.ok(execCall.args.includes('echo hello'));
  });

  it('a caller-supplied timeoutSeconds cannot exceed the profile ceiling', async () => {
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok('');
      if (ctx.args[0] === 'run') return ok();
      return ok();
    });
    const backend = new DockerSandboxBackend({ execDocker: exec });
    const sandbox = await backend.provision({
      scopeKey: 'personal:clamp-test',
      profile: resolveAgentComputerProfile({ maxRunSeconds: 5 }),
    });
    await sandbox.run('sleep 999', { timeoutSeconds: 999 });
    const execCall = calls[calls.length - 1]!;
    assert.ok(execCall.args.includes('5s'), `expected clamp to 5s, got: ${JSON.stringify(execCall.args)}`);
    assert.ok(!execCall.args.includes('999s'));
  });

  it('surfaces timedOut when the wrapped `timeout` exits 124', async () => {
    const { exec } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok('');
      if (ctx.args[0] === 'run') return ok();
      return { exitCode: 124, stdout: '', stderr: '', timedOut: false, outputTruncated: false };
    });
    const backend = new DockerSandboxBackend({ execDocker: exec });
    const sandbox = await backend.provision({ scopeKey: 'personal:timeout-test', profile: resolveAgentComputerProfile() });
    const result = await sandbox.run('sleep 999');
    assert.equal(result.timedOut, true);
  });
});

describe('DockerSandbox.read/write/list — traversal hardening', () => {
  async function provisioned(script: (ctx: DockerExecContext) => DockerExecResult) {
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok('');
      if (ctx.args[0] === 'run') return ok();
      return script(ctx);
    });
    const backend = new DockerSandboxBackend({ execDocker: exec });
    const sandbox = await backend.provision({ scopeKey: 'personal:fs-test', profile: resolveAgentComputerProfile() });
    return { sandbox, calls };
  }

  it('read() rejects a traversal attempt WITHOUT ever calling docker exec for it', async () => {
    const { sandbox, calls } = await provisioned(() => ok('should not be reached'));
    const before = calls.length;
    const result = await sandbox.read('../../etc/passwd');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'path_rejected');
    assert.equal(calls.length, before, 'the path guard must short-circuit before any docker exec call');
  });

  it('read() returns content on success', async () => {
    const { sandbox } = await provisioned(() => ok('file contents\n'));
    const result = await sandbox.read('notes.txt');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.content, 'file contents\n');
  });

  it('read() maps a missing file to not_found', async () => {
    const { sandbox } = await provisioned(() => fail("cat: can't open 'x': No such file or directory"));
    const result = await sandbox.read('missing.txt');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not_found');
  });

  it('write() rejects a traversal attempt without touching docker', async () => {
    const { sandbox, calls } = await provisioned(() => ok());
    const before = calls.length;
    const result = await sandbox.write('../outside.txt', 'x');
    assert.equal(result.ok, false);
    assert.equal(calls.length, before);
  });

  it('write() pipes content via stdin to the docker exec call', async () => {
    const { sandbox, calls } = await provisioned(() => ok());
    const result = await sandbox.write('notes.txt', 'hello sandbox');
    assert.equal(result.ok, true);
    const call = calls[calls.length - 1]!;
    assert.equal(call.input, 'hello sandbox');
    assert.ok(call.args.includes('-i'));
  });

  it('list() parses busybox `ls -1p` output into dir/file entries', async () => {
    const { sandbox } = await provisioned(() => ok('subdir/\nfile.txt\n'));
    const result = await sandbox.list('.');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.entries.map((e) => `${e.name}:${e.kind}`).sort(),
        ['file.txt:file', 'subdir:dir'],
      );
    }
  });

  it('list() rejects a traversal attempt without touching docker', async () => {
    const { sandbox, calls } = await provisioned(() => ok());
    const before = calls.length;
    const result = await sandbox.list('../../');
    assert.equal(result.ok, false);
    assert.equal(calls.length, before);
  });
});

describe('DockerSandbox.teardown', () => {
  it('removes the container by id', async () => {
    const { exec, calls } = stubExec((ctx) => {
      if (ctx.args[0] === 'ps') return ok('');
      return ok();
    });
    const backend = new DockerSandboxBackend({ execDocker: exec });
    const sandbox = await backend.provision({ scopeKey: 'personal:teardown-test', profile: resolveAgentComputerProfile() });
    await sandbox.teardown();
    const rmCall = calls[calls.length - 1]!;
    assert.deepEqual(rmCall.args, ['rm', '-f', sandbox.id]);
  });
});

// ---------------------------------------------------------------------------
// REAL-DOCKER tier — opt-in, gated on SANDBOX_DOCKER_TEST=1 (never runs in
// CI unless a job explicitly sets it). Proves the stub's assumptions against
// a real daemon: image pull, container lifecycle, and — most importantly —
// that `--network none` actually blocks egress rather than merely being an
// argv the stub tests observed.
// ---------------------------------------------------------------------------
const DOCKER_TEST_ENABLED = process.env['SANDBOX_DOCKER_TEST'] === '1';
const describeIfDocker = DOCKER_TEST_ENABLED ? describe : describe.skip;
const containersToClean: string[] = [];

describeIfDocker('DockerSandboxBackend — real Docker (SANDBOX_DOCKER_TEST=1)', () => {
  after(() => {
    for (const name of containersToClean) {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('provisions a container, runs a command, and round-trips a file', async () => {
    const backend = new DockerSandboxBackend();
    const sandbox = await backend.provision({
      scopeKey: `personal:real-docker-${String(Date.now())}`,
      profile: resolveAgentComputerProfile({ egress: true }),
    });
    containersToClean.push(sandbox.id);

    const run = await sandbox.run('echo hello-sandbox');
    assert.equal(run.exitCode, 0);
    assert.equal(run.stdout.trim(), 'hello-sandbox');

    const write = await sandbox.write('greeting.txt', 'durable hello');
    assert.equal(write.ok, true);
    const read = await sandbox.read('greeting.txt');
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.content, 'durable hello');

    const list = await sandbox.list('.');
    assert.equal(list.ok, true);
    if (list.ok) assert.ok(list.entries.some((e) => e.name === 'greeting.txt'));

    await sandbox.teardown();
  });

  it('egress:false actually blocks an outbound request — not just the argv', async () => {
    const backend = new DockerSandboxBackend();
    const sandbox = await backend.provision({
      scopeKey: `personal:egress-block-${String(Date.now())}`,
      profile: resolveAgentComputerProfile({ egress: false, maxRunSeconds: 10 }),
    });
    containersToClean.push(sandbox.id);

    const result = await sandbox.run('wget -T 3 -q -O- https://example.com');
    // busybox wget exits non-zero when the network is unreachable
    // (--network none gives the container no route at all).
    assert.notEqual(result.exitCode, 0);

    await sandbox.teardown();
  });
});

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
});
