import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  LOCAL_WORKSPACE_PREFIX,
  LocalProcessBackend,
  SHIM_PID_FILE,
  buildShimEnv,
  type LocalProcessBackendOptions,
  type SpawnedShim,
} from '../../src/devplatform/localProcessBackend.js';
import { RunnerBackendError, type DevJobProvisionContext } from '../../src/devplatform/runnerBackend.js';

/**
 * Epic #470 W0 — the jailed LocalProcessBackend (spec §1/§5):
 *   - refuses to exist without the DEV_PLATFORM_UNSAFE_LOCAL=true acknowledgment
 *   - refuses runs_tests repos and non-admin sources at its own boundary
 *   - builds the shim env as an ALLOWLIST (no Vault path, no DATABASE_URL,
 *     no CLAUDE_CONFIG_DIR, never the parent HOME)
 *   - sets OMADIA_LLM_ENV_ALLOWED=true iff the acknowledgment is present
 *   - terminate escalates SIGTERM → SIGKILL and removes the workspace
 *   - reap kills orphan pids (via the pid file) and removes leftover dirs
 */

// ---------------------------------------------------------------------------
// Fakes — a controllable process table + spawn.
// ---------------------------------------------------------------------------

interface KillCall {
  pid: number;
  signal: NodeJS.Signals;
}

class FakeProcs {
  readonly kills: KillCall[] = [];
  readonly alive = new Set<number>();
  /** pgid (= leader pid) → extra member pids, so `kill(-pgid)` group semantics
   *  can be modeled: a group signal hits every live member, and the group
   *  exists as long as ANY member lives — even after the leader died. */
  readonly groups = new Map<number, Set<number>>();
  /** When true, a SIGTERM already kills the process (a cooperative shim). */
  cooperative = false;
  /** Members that are alive but NOT ours to signal — kill() throws EPERM.
   *  Models a process owned by another uid: the group is alive but unreachable,
   *  so a kill can never CONFIRM exit (the whole point of the fix). */
  readonly unkillable = new Set<number>();
  /** Members that accept a signal (it IS recorded) but never die — models a
   *  process that outlives the grace window. Proves signal-delivery ≠ exit. */
  readonly immortal = new Set<number>();

  readonly kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    if (signal !== 0) this.kills.push({ pid, signal });
    const lethal = signal === 'SIGKILL' || (signal === 'SIGTERM' && this.cooperative);
    if (pid < 0) {
      const pgid = -pid;
      const members = [pgid, ...(this.groups.get(pgid) ?? [])].filter((m) => this.alive.has(m));
      if (members.length === 0) throw esrch(pid);
      const reachable = members.filter((m) => !this.unkillable.has(m));
      // kill(2) on a group: EPERM only when NONE of the live members can be
      // signalled. If at least one is reachable, the call succeeds.
      if (reachable.length === 0) throw eperm(pid);
      if (lethal) for (const m of reachable) if (!this.immortal.has(m)) this.alive.delete(m);
      return;
    }
    if (!this.alive.has(pid)) throw esrch(pid);
    if (this.unkillable.has(pid)) throw eperm(pid);
    if (lethal && !this.immortal.has(pid)) this.alive.delete(pid);
  };

  signalsFor(pid: number): NodeJS.Signals[] {
    return this.kills.filter((c) => Math.abs(c.pid) === pid).map((c) => c.signal);
  }
}

function esrch(pid: number): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`kill ESRCH ${String(pid)}`);
  err.code = 'ESRCH';
  return err;
}

function eperm(pid: number): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`kill EPERM ${String(pid)}`);
  err.code = 'EPERM';
  return err;
}

interface SpawnCall {
  command: string;
  args: string[];
  options: { cwd?: unknown; env?: NodeJS.ProcessEnv; detached?: boolean; uid?: number; gid?: number };
  pid: number;
}

let nextFakePid = 40_000;

function makeSpawn(
  procs: FakeProcs,
  calls: SpawnCall[],
  opts: { fail?: boolean; unrefThrows?: boolean; immortal?: boolean } = {},
) {
  return (command: string, args: string[], options: SpawnCall['options']): SpawnedShim => {
    const pid = nextFakePid++;
    const child = new EventEmitter() as EventEmitter & { pid?: number; unref(): void };
    child.pid = pid;
    // A post-spawn failure surface: the shim is ALIVE (emitted 'spawn') but
    // provision() throws afterwards. unref() is the first thing called once the
    // pid is in hand, so throwing here reproduces "failure after a live spawn".
    child.unref = opts.unrefThrows
      ? () => {
          throw new Error('unref boom (fake post-spawn failure)');
        }
      : () => undefined;
    calls.push({ command, args, options, pid });
    if (opts.fail) {
      queueMicrotask(() => child.emit('error', new Error('spawn EPERM (fake)')));
    } else {
      procs.alive.add(pid);
      if (opts.immortal) procs.immortal.add(pid);
      queueMicrotask(() => child.emit('spawn'));
    }
    return child as unknown as SpawnedShim;
  };
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];
after(async () => {
  await Promise.all(tmpRoots.map((d) => rm(d, { recursive: true, force: true })));
});

async function makeBackend(
  over: Partial<LocalProcessBackendOptions> = {},
  spawnOpts: { fail?: boolean; unrefThrows?: boolean; immortal?: boolean } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omadia-lpb-test-'));
  tmpRoots.push(root);
  const procs = new FakeProcs();
  const spawnCalls: SpawnCall[] = [];
  const logs: string[] = [];
  const backend = new LocalProcessBackend({
    unsafeLocalAck: true,
    localUid: 4242,
    workspaceDir: root,
    shimEntry: '/opt/omadia/dev-runner-shim/dist/src/index.js',
    cliBin: 'claude',
    killGraceMs: 60,
    pollIntervalMs: 5,
    log: (m) => logs.push(m),
    spawnFn: makeSpawn(procs, spawnCalls, spawnOpts) as LocalProcessBackendOptions['spawnFn'],
    procKill: procs.kill,
    ...over,
  });
  return { backend, root, procs, spawnCalls, logs };
}

function ctx(over: Partial<DevJobProvisionContext> = {}): DevJobProvisionContext {
  return {
    jobId: '0189aabb-ccdd-7eef-8123-456789abcdef',
    jobToken: 'djr_test-token-not-a-secret',
    baseUrl: 'http://127.0.0.1:3000',
    source: 'admin',
    repo: { runsTests: false },
    ...over,
  };
}

function isRefusal(code: string): (err: unknown) => boolean {
  return (err: unknown) => {
    assert.ok(err instanceof RunnerBackendError, `expected RunnerBackendError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('devplatform/localProcessBackend', () => {
  it('refuses to start without DEV_PLATFORM_UNSAFE_LOCAL=true', () => {
    assert.throws(
      () =>
        new LocalProcessBackend({
          unsafeLocalAck: false,
          localUid: 4242,
          workspaceDir: '/tmp/x',
          shimEntry: '/opt/shim.js',
        }),
      isRefusal('devplatform.local_backend_disabled'),
    );
  });

  it('refuses a missing, non-integer, or root uid', () => {
    for (const localUid of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () =>
          new LocalProcessBackend({
            unsafeLocalAck: true,
            localUid,
            workspaceDir: '/tmp/x',
            shimEntry: '/opt/shim.js',
          }),
        isRefusal('devplatform.local_uid_required'),
        `uid ${String(localUid)} must be refused`,
      );
    }
  });

  it('logs a boot warning naming the restriction', async () => {
    const { logs } = await makeBackend();
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /DEV_PLATFORM_UNSAFE_LOCAL=true/);
    assert.match(logs[0]!, /no dependency install, no test execution/);
    assert.match(logs[0]!, /runs_tests=true and non-admin sources are refused/);
  });

  it('refuses a repo with runs_tests=true', async () => {
    const { backend, spawnCalls } = await makeBackend();
    await assert.rejects(
      backend.provision(ctx({ repo: { runsTests: true } })),
      isRefusal('devplatform.local_backend_requires_no_exec'),
    );
    assert.equal(spawnCalls.length, 0, 'nothing was spawned');
  });

  it('refuses any source other than admin', async () => {
    const { backend, spawnCalls } = await makeBackend();
    for (const source of ['chat', 'conductor', 'webhook', 'schedule', 'tracker'] as const) {
      await assert.rejects(
        backend.provision(ctx({ source })),
        isRefusal('devplatform.local_backend_admin_only'),
        `source '${source}' must be refused`,
      );
    }
    assert.equal(spawnCalls.length, 0, 'nothing was spawned');
  });

  it('fails closed when the admission facts are missing from the input', async () => {
    const { backend, spawnCalls } = await makeBackend();
    const bare = {
      jobId: 'j',
      jobToken: 't',
      baseUrl: 'http://127.0.0.1:3000',
    } as unknown as DevJobProvisionContext;
    await assert.rejects(backend.provision(bare), isRefusal('devplatform.admission_context_missing'));
    assert.equal(spawnCalls.length, 0, 'nothing was spawned');
  });

  it('spawns the shim detached as the jail uid with an allowlist env (no Vault path, no DATABASE_URL, no CLAUDE_CONFIG_DIR)', async () => {
    // Pollute the parent env with exactly the secrets the allowlist must not
    // forward — a scrub-list would have to know these names; an allowlist
    // never sees them.
    const pollution: Record<string, string> = {
      DATABASE_URL: 'postgres://secret@db/omadia',
      CLAUDE_CONFIG_DIR: '/home/operator/.claude',
      VAULT_KEY: 'base64-master-key',
      DEV_PLATFORM_VAULT_DIR: '/var/lib/omadia/vault',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    };
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(pollution)) {
      saved.set(k, process.env[k]);
      process.env[k] = v;
    }
    try {
      const { backend, root, spawnCalls } = await makeBackend({
        llm: { anthropicBaseUrl: 'http://127.0.0.1:9999', anthropicAuthToken: 'proxy-token' },
      });
      const input = ctx();
      const handle = await backend.provision(input);

      assert.equal(handle.backend, 'local');
      assert.ok(handle.id.startsWith(path.join(root, LOCAL_WORKSPACE_PREFIX)), 'workspace under the root');
      assert.equal(typeof handle.pid, 'number');

      assert.equal(spawnCalls.length, 1);
      const call = spawnCalls[0]!;
      assert.equal(call.command, process.execPath);
      assert.deepEqual(call.args, ['/opt/omadia/dev-runner-shim/dist/src/index.js']);
      assert.equal(call.options.detached, true, 'own process group');
      assert.equal(call.options.uid, 4242, 'runs as the jail uid');

      const env = call.options.env!;
      // The five OMADIA_* shim inputs + the gate (protocol.ts readShimEnv).
      assert.equal(env['OMADIA_JOB_BASE_URL'], input.baseUrl);
      assert.equal(env['OMADIA_JOB_ID'], input.jobId);
      assert.equal(env['OMADIA_JOB_TOKEN'], input.jobToken);
      assert.equal(env['OMADIA_WORKSPACE'], handle.id);
      assert.equal(env['OMADIA_CLI_BIN'], 'claude');
      assert.equal(env['OMADIA_LLM_ENV_ALLOWED'], 'true');
      assert.equal(env['OMADIA_ANTHROPIC_BASE_URL'], 'http://127.0.0.1:9999');
      assert.equal(env['OMADIA_ANTHROPIC_AUTH_TOKEN'], 'proxy-token');
      // Job-scoped HOME — never the parent HOME.
      assert.equal(env['HOME'], handle.id);
      assert.notEqual(env['HOME'], process.env['HOME']);
      // The acceptance-criteria absences, plus everything else we polluted.
      for (const key of Object.keys(pollution)) {
        assert.equal(key in env, false, `${key} must not cross into the shim env`);
      }
      // Nothing beyond the allowlist leaks: enumerate what IS there.
      const allowed = new Set([
        'PATH',
        'HOME',
        'LANG',
        'TERM',
        'OMADIA_JOB_BASE_URL',
        'OMADIA_JOB_ID',
        'OMADIA_JOB_TOKEN',
        'OMADIA_WORKSPACE',
        'OMADIA_CLI_BIN',
        'OMADIA_LLM_ENV_ALLOWED',
        'OMADIA_ANTHROPIC_BASE_URL',
        'OMADIA_ANTHROPIC_AUTH_TOKEN',
      ]);
      for (const key of Object.keys(env)) {
        assert.ok(allowed.has(key), `unexpected env key crossed the allowlist: ${key}`);
      }

      // The pid file that reap() uses across a restart.
      const pidRaw = await readFile(path.join(handle.id, SHIM_PID_FILE), 'utf8');
      assert.equal(Number.parseInt(pidRaw.trim(), 10), handle.pid);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('sets OMADIA_LLM_ENV_ALLOWED=true if and only if the unsafe-local acknowledgment is present', () => {
    const base = {
      input: { jobId: 'j', jobToken: 't', baseUrl: 'http://127.0.0.1:3000' },
      workspace: '/tmp/ws',
      cliBin: 'claude',
      llm: { anthropicBaseUrl: 'http://proxy', anthropicAuthToken: 'tok' },
      parentEnv: { PATH: '/usr/bin', HOME: '/home/operator' },
    };
    const withAck = buildShimEnv({ ...base, unsafeLocalAck: true });
    assert.equal(withAck['OMADIA_LLM_ENV_ALLOWED'], 'true');
    assert.equal(withAck['OMADIA_ANTHROPIC_AUTH_TOKEN'], 'tok');

    // Without the acknowledgment the key is OMITTED (not 'false'), and the
    // LLM credential pair never enters the env either — the shim would refuse
    // to wire ANTHROPIC_* into the child CLI, and there is nothing to leak.
    const withoutAck = buildShimEnv({ ...base, unsafeLocalAck: false });
    assert.equal('OMADIA_LLM_ENV_ALLOWED' in withoutAck, false);
    assert.equal('OMADIA_ANTHROPIC_BASE_URL' in withoutAck, false);
    assert.equal('OMADIA_ANTHROPIC_AUTH_TOKEN' in withoutAck, false);
  });

  it('terminate escalates SIGTERM → SIGKILL on a stubborn shim and removes the workspace', async () => {
    const { backend, procs, root } = await makeBackend();
    const handle = await backend.provision(ctx());
    const pid = handle.pid!;

    await backend.terminate(handle);

    assert.deepEqual(procs.signalsFor(pid), ['SIGTERM', 'SIGKILL'], 'escalated after the grace window');
    assert.ok(procs.kills.some((c) => c.pid === -pid), 'signals target the process group');
    assert.equal(procs.alive.has(pid), false, 'the shim is dead');
    const leftovers = await readdir(root);
    assert.deepEqual(leftovers, [], 'workspace removed');
  });

  it('terminate stops at SIGTERM when the shim exits cooperatively', async () => {
    const { backend, procs } = await makeBackend();
    procs.cooperative = true;
    const handle = await backend.provision(ctx());

    await backend.terminate(handle);

    assert.deepEqual(procs.signalsFor(handle.pid!), ['SIGTERM'], 'no SIGKILL needed');
  });

  it('terminate is idempotent on an already-dead runner', async () => {
    const { backend, procs } = await makeBackend();
    const handle = await backend.provision(ctx());
    procs.alive.delete(handle.pid!); // died on its own, whole group gone with it
    await backend.terminate(handle); // must not throw
    assert.deepEqual(procs.signalsFor(handle.pid!), [], 'no signal sent to a dead group');
  });

  it('terminate SIGKILLs a live group child left behind by a dead shim leader before removing the workspace', async () => {
    const { backend, procs, root } = await makeBackend();
    const handle = await backend.provision(ctx());
    const shimPid = handle.pid!;
    // The shim spawned the CLI non-detached (same process group), then died
    // abnormally (OOM/SIGKILL) — its finally-cleanup never ran, so the group
    // still holds a live child carrying ANTHROPIC_* credentials. terminate()
    // must key on GROUP liveness, not the dead leader, or the child survives
    // untracked with no workspace and no pid file left to reap it by.
    const cliChildPid = nextFakePid++;
    procs.alive.add(cliChildPid);
    procs.groups.set(shimPid, new Set([cliChildPid]));
    procs.alive.delete(shimPid); // leader dead, group still has a live member

    await backend.terminate(handle);

    assert.deepEqual(procs.signalsFor(shimPid), ['SIGTERM', 'SIGKILL'], 'the group was signalled despite the dead leader');
    assert.ok(
      procs.kills.some((c) => c.pid === -shimPid && c.signal === 'SIGKILL'),
      'the SIGKILL targeted the whole process group',
    );
    assert.equal(procs.alive.has(cliChildPid), false, 'the orphaned CLI child is dead');
    assert.deepEqual(await readdir(root), [], 'workspace removed');
  });

  it('terminate refuses a handle whose id escapes the workspace root', async () => {
    const { backend } = await makeBackend();
    const hostile = { backend: 'local' as const, id: '/etc', pid: 1, startedAt: new Date().toISOString() };
    await assert.rejects(backend.terminate(hostile), isRefusal('devplatform.local_workspace_escape'));
  });

  it('reap kills orphan pids from the pid file and removes leftover workspaces', async () => {
    const { backend, procs, root } = await makeBackend();

    // An orphan from a previous middleware process: dir + pid file, no
    // in-memory tracking, pid still alive.
    const orphanPid = nextFakePid++;
    procs.alive.add(orphanPid);
    const orphanDir = path.join(root, `${LOCAL_WORKSPACE_PREFIX}orphan-xyz`);
    await mkdir(orphanDir, { recursive: true });
    await writeFile(path.join(orphanDir, SHIM_PID_FILE), `${String(orphanPid)}\n`, 'utf8');
    // A stray non-job dir must be left alone.
    await mkdir(path.join(root, 'unrelated'), { recursive: true });

    const reaped = await backend.reap();

    assert.equal(reaped.length, 1);
    assert.equal(reaped[0]!.id, orphanDir);
    assert.equal(reaped[0]!.pid, orphanPid);
    assert.deepEqual(procs.signalsFor(orphanPid), ['SIGKILL'], 'orphan killed outright');
    assert.equal(procs.alive.has(orphanPid), false);
    const leftovers = await readdir(root);
    assert.deepEqual(leftovers.sort(), ['unrelated'], 'orphan workspace removed, stray dir untouched');
  });

  it('reap SIGKILLs an orphan group whose leader is already dead but whose CLI child lives', async () => {
    const { backend, procs, root } = await makeBackend();

    // A previous middleware run left a workspace behind. Its shim leader was
    // OOM-killed, so the pid file names a dead pid — but the leader's process
    // group still holds the CLI child, which carries ANTHROPIC_* credentials.
    const deadLeaderPid = nextFakePid++;
    const liveChildPid = nextFakePid++;
    procs.alive.add(liveChildPid);
    procs.groups.set(deadLeaderPid, new Set([liveChildPid]));
    const orphanDir = path.join(root, `${LOCAL_WORKSPACE_PREFIX}orphan-dead-leader`);
    await mkdir(orphanDir, { recursive: true });
    await writeFile(path.join(orphanDir, SHIM_PID_FILE), `${String(deadLeaderPid)}\n`, 'utf8');

    const reaped = await backend.reap();

    assert.equal(reaped.length, 1);
    // The signal goes to the group (kill(-pgid)), which is recorded under the
    // leader pid — the child dying is what proves the group was hit.
    assert.deepEqual(procs.signalsFor(deadLeaderPid), ['SIGKILL'], 'the dead leader’s group is killed');
    assert.equal(procs.alive.has(liveChildPid), false, 'no credential-bearing orphan outlives its job');
    assert.deepEqual(await readdir(root), [], 'orphan workspace removed');
  });

  it('reap returns dead tracked runners (for finalizeDevJob) and leaves live ones alone', async () => {
    const { backend, procs, root } = await makeBackend();
    const liveHandle = await backend.provision(ctx({ jobId: 'aaaaaaaa-1111-7bbb-8ccc-dddddddddddd' }));
    const deadHandle = await backend.provision(ctx({ jobId: 'bbbbbbbb-2222-7ccc-8ddd-eeeeeeeeeeee' }));
    procs.alive.delete(deadHandle.pid!); // crashed without terminate()

    const reaped = await backend.reap();

    assert.deepEqual(
      reaped.map((h) => h.id),
      [deadHandle.id],
      'exactly the dead runner is reaped',
    );
    const leftovers = await readdir(root);
    assert.deepEqual(leftovers, [path.basename(liveHandle.id)], 'live workspace untouched');
    assert.equal(procs.alive.has(liveHandle.pid!), true, 'live shim not signalled');
  });

  it('reap SIGKILLs the dead tracked runner’s whole group so an orphaned CLI child cannot outlive the job', async () => {
    const { backend, procs, root } = await makeBackend();
    const handle = await backend.provision(ctx());
    const shimPid = handle.pid!;
    // The shim spawned a CLI child (carrying ANTHROPIC_* via the gated
    // passthrough) into its own process group, then died abnormally
    // (OOM/SIGKILL) — its finally-cleanup never ran, the child lives on.
    const cliChildPid = nextFakePid++;
    procs.alive.add(cliChildPid);
    procs.groups.set(shimPid, new Set([cliChildPid]));
    procs.alive.delete(shimPid); // leader dead, group still has a live member

    const reaped = await backend.reap();

    assert.deepEqual(
      reaped.map((h) => h.id),
      [handle.id],
      'the dead tracked runner is reaped',
    );
    assert.ok(
      procs.kills.some((c) => c.pid === -shimPid && c.signal === 'SIGKILL'),
      'the whole process group was SIGKILLed, not just the dead leader',
    );
    assert.equal(procs.alive.has(cliChildPid), false, 'the orphaned CLI child is dead');
    assert.deepEqual(await readdir(root), [], 'workspace removed');
  });

  it('cleans up the workspace when the spawn itself fails', async () => {
    const { backend, root } = await makeBackend({}, { fail: true });
    await assert.rejects(backend.provision(ctx()), isRefusal('devplatform.local_spawn_failed'));
    assert.deepEqual(await readdir(root), [], 'no leftover workspace');
  });

  it('terminate keeps the workspace and pid file when the group cannot be confirmed dead (EPERM)', async () => {
    const { backend, procs, root } = await makeBackend();
    const handle = await backend.provision(ctx());
    const pid = handle.pid!;
    // The group is alive but owned by someone else: every kill throws EPERM.
    // Signal delivery FAILS, so exit can never be confirmed — deleting the
    // workspace here would strand a live, credential-bearing group with no
    // handle left to reap it by.
    procs.unkillable.add(pid);

    await assert.rejects(
      backend.terminate(handle),
      isRefusal('devplatform.local_terminate_incomplete'),
    );

    assert.equal(procs.alive.has(pid), true, 'the unsignalable group is still alive');
    const leftovers = await readdir(root);
    assert.deepEqual(leftovers, [path.basename(handle.id)], 'workspace NOT removed');
    const pidRaw = await readFile(path.join(handle.id, SHIM_PID_FILE), 'utf8');
    assert.equal(Number.parseInt(pidRaw.trim(), 10), pid, 'pid file preserved for reap()');
  });

  it('terminate keeps the workspace when SIGKILL is delivered but the group outlives the grace window', async () => {
    const { backend, procs, root } = await makeBackend();
    const handle = await backend.provision(ctx());
    const shimPid = handle.pid!;
    // A CLI child that accepts signals (they are recorded) but does not die
    // within the grace window. The leader is gone; signal delivery to the group
    // succeeds, yet the group has NOT exited — the fix must not delete the
    // workspace on the strength of a delivered signal alone.
    const stubbornChild = nextFakePid++;
    procs.alive.add(stubbornChild);
    procs.immortal.add(stubbornChild);
    procs.groups.set(shimPid, new Set([stubbornChild]));
    procs.alive.delete(shimPid);

    await assert.rejects(
      backend.terminate(handle),
      isRefusal('devplatform.local_terminate_incomplete'),
    );

    // The group WAS signalled (SIGTERM then SIGKILL) — delivery is not the same
    // as exit, and that is exactly what the workspace-retention guards against.
    assert.deepEqual(procs.signalsFor(shimPid), ['SIGTERM', 'SIGKILL'], 'the group was signalled');
    assert.equal(procs.alive.has(stubbornChild), true, 'the child outlived the signals');
    assert.deepEqual(await readdir(root), [path.basename(handle.id)], 'workspace NOT removed before verified exit');
  });

  it('reap leaves a tracked runner whose group cannot be confirmed dead for the next sweep', async () => {
    const { backend, procs, root } = await makeBackend();
    const handle = await backend.provision(ctx());
    const shimPid = handle.pid!;
    const stubbornChild = nextFakePid++;
    procs.alive.add(stubbornChild);
    procs.immortal.add(stubbornChild); // survives SIGKILL within the window
    procs.groups.set(shimPid, new Set([stubbornChild]));
    procs.alive.delete(shimPid); // leader dead, group still live

    const reaped = await backend.reap();

    assert.deepEqual(reaped, [], 'nothing reaped while the group is still alive');
    assert.deepEqual(
      await readdir(root),
      [path.basename(handle.id)],
      'workspace kept — its pid file is the only reap handle',
    );
    // Still tracked, so a later reap() (once the child finally dies) retries it.
    procs.immortal.delete(stubbornChild);
    procs.alive.delete(stubbornChild);
    const retried = await backend.reap();
    assert.deepEqual(
      retried.map((h) => h.id),
      [handle.id],
      'the next sweep reaps it once the group is provably gone',
    );
    assert.deepEqual(await readdir(root), [], 'workspace removed on confirmed exit');
  });

  it('reap leaves an orphan whose group cannot be confirmed dead (EPERM) for the next sweep', async () => {
    const { backend, procs, root } = await makeBackend();
    const orphanPid = nextFakePid++;
    procs.alive.add(orphanPid);
    procs.unkillable.add(orphanPid); // alive, unsignalable → kill can't confirm
    const orphanDir = path.join(root, `${LOCAL_WORKSPACE_PREFIX}orphan-eperm`);
    await mkdir(orphanDir, { recursive: true });
    await writeFile(path.join(orphanDir, SHIM_PID_FILE), `${String(orphanPid)}\n`, 'utf8');

    const reaped = await backend.reap();

    assert.deepEqual(reaped, [], 'the unconfirmed orphan is NOT reaped');
    assert.equal(procs.alive.has(orphanPid), true, 'the orphan group is still alive');
    assert.deepEqual(await readdir(root), [path.basename(orphanDir)], 'orphan workspace kept');
    const pidRaw = await readFile(path.join(orphanDir, SHIM_PID_FILE), 'utf8');
    assert.equal(Number.parseInt(pidRaw.trim(), 10), orphanPid, 'orphan pid file preserved for the next sweep');
  });

  it('kills the live shim before removing the workspace when provision fails after spawn', async () => {
    const { backend, procs, root } = await makeBackend({}, { unrefThrows: true });
    await assert.rejects(backend.provision(ctx()), isRefusal('devplatform.local_spawn_failed'));

    // The shim was already running when provision() threw. It must be killed —
    // not just have its workspace deleted out from under it.
    assert.equal(procs.kills.some((c) => c.signal === 'SIGKILL'), true, 'the live shim group was SIGKILLed');
    assert.equal([...procs.alive].length, 0, 'no shim left alive');
    assert.deepEqual(await readdir(root), [], 'workspace removed only after the group exited');
  });

  it('keeps the workspace and writes a pid file when a post-spawn failure leaves an unkillable group', async () => {
    const { backend, procs, root } = await makeBackend({}, { unrefThrows: true, immortal: true });
    await assert.rejects(backend.provision(ctx()), isRefusal('devplatform.local_spawn_failed'));

    // The shim spawned, provision() failed, and the group would not die. Rather
    // than rm the workspace and orphan the live credential-bearing process, the
    // catch keeps the dir and (re)writes the pid file so reap() can retry.
    const dirs = await readdir(root);
    assert.equal(dirs.length, 1, 'workspace kept for reap()');
    assert.equal([...procs.alive].length, 1, 'the live shim was not stranded silently');
    const pidRaw = await readFile(path.join(root, dirs[0]!, SHIM_PID_FILE), 'utf8');
    assert.equal(Number.parseInt(pidRaw.trim(), 10), [...procs.alive][0], 'pid file names the live shim');
  });
});
