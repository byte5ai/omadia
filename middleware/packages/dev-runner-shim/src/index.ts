/**
 * Epic #470 W0 — runner shim entrypoint (spec §5).
 *
 * Lifecycle: fetch spec (abort loudly on a protocol skew) → clone read-only at
 * the pinned base sha → drive the headless CLI, streaming batched events home,
 * heartbeating every 30 s and honouring a cancel → stage the work tree, upload
 * the diff + numstat, and report the outcome. The shim holds NO write
 * credential and moves NO ref; the middleware applies the diff server-side.
 *
 * Node builtins only — no middleware import.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { HomeClient, HomeError, type HomeApi } from './homeClient.js';
import { cloneAtBaseSha, collectDiff, type GitOptions } from './gitOps.js';
import { bundleDiff } from './diffUpload.js';
import { runAgent } from './agentRunner.js';
import { runPhasedShim } from './phaseLoop.js';
import {
  RUNNER_PROTOCOL_VERSION,
  readShimEnv,
  type RunnerEvent,
  type RunnerResult,
  type ShimEnv,
} from './protocol.js';

export { runPhasedShim } from './phaseLoop.js';

const HEARTBEAT_MS = 30_000;

export interface ShimDeps {
  home?: HomeApi;
  gitBin?: string;
  now?: () => string;
  log?: (line: string) => void;
  /** SIGTERM→SIGKILL escalation window on a wall-clock kill. Test hook. */
  killGraceMs?: number;
}

/** Run the full shim lifecycle. Returns the process exit code. */
export async function runShim(env: ShimEnv = readShimEnv(), deps: ShimDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => process.stderr.write(`[dev-runner-shim] ${l}\n`));
  const home = deps.home ?? new HomeClient(env);

  // 1. Spec + protocol gate. A skew fails loudly with BOTH versions named.
  const spec = await home.fetchSpec();
  if (spec.protocol !== RUNNER_PROTOCOL_VERSION) {
    const message =
      `runner protocol mismatch: shim speaks v${String(RUNNER_PROTOCOL_VERSION)}, ` +
      `middleware sent v${String(spec.protocol)}`;
    log(message);
    await safeResult(home, { outcome: 'failed', error: message }, log);
    return 1;
  }

  // Serialized event sender: stamp a per-provision monotonic seq synchronously
  // (so order is fixed at emit time), then post batches in order.
  let nextSeq = 0;
  let postChain: Promise<void> = Promise.resolve();
  const emit = (events: RunnerEvent[]): void => {
    const stamped = events.map((e) => ({ ...e, seq: nextSeq++ }));
    postChain = postChain
      .then(() => home.postEvents(spec.provision, stamped))
      .then(() => undefined)
      .catch((err: unknown) => log(`event post failed: ${errText(err)}`));
  };

  // 2. Heartbeat + cancel channel.
  let cancelled = false;
  let killAgent: ((signal?: NodeJS.Signals) => void) | null = null;
  let wallTimer: NodeJS.Timeout | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  const heartbeat = setInterval(() => {
    void home
      .heartbeat()
      .then((reply) => {
        if (reply.cancelRequested && !cancelled) {
          cancelled = true;
          log('cancel requested — terminating agent');
          killAgent?.();
        }
      })
      .catch((err: unknown) => log(`heartbeat failed: ${errText(err)}`));
  }, HEARTBEAT_MS);

  try {
    // 3. Read-only clone at the pinned tree.
    const gitOpts: GitOptions = {
      workspace: env.workspace,
      ...(deps.gitBin ? { gitBin: deps.gitBin } : {}),
      fetchToken: async () => (await home.fetchScmToken()).token,
      logger: log,
    };
    const repoDir = await cloneAtBaseSha(gitOpts, spec.repo);

    // 4. Drive the agent.
    //
    // LLM auth passthrough is GATED (see ShimEnv.llmEnvAllowed): in W0 the
    // `OMADIA_ANTHROPIC_*` pair is the middleware's own long-lived proxy
    // secret, so it crosses into the child ONLY when the backend was launched
    // with the jail acknowledgment and plumbed `OMADIA_LLM_ENV_ALLOWED=true`.
    // W1's per-job, short-lived LLM-proxy tokens replace this passthrough.
    const proxyBaseUrl = process.env['OMADIA_ANTHROPIC_BASE_URL']?.trim();
    const proxyToken = process.env['OMADIA_ANTHROPIC_AUTH_TOKEN']?.trim();
    if (proxyToken && !env.llmEnvAllowed) {
      log(
        'OMADIA_ANTHROPIC_AUTH_TOKEN is set but OMADIA_LLM_ENV_ALLOWED!=true — ' +
          'withholding LLM auth from the child (W0 jail acknowledgment missing)',
      );
    }
    // The child gets a fresh, job-scoped HOME inside the workspace — never the
    // runner user's real HOME (which holds ~/.claude credentials and config).
    const agentHome = path.join(env.workspace, 'home');
    await mkdir(agentHome, { recursive: true });
    const agent = runAgent({
      cliBin: env.cliBin,
      cwd: repoDir,
      homeDir: agentHome,
      spec,
      llmEnvAllowed: env.llmEnvAllowed,
      ...(proxyBaseUrl ? { proxyBaseUrl } : {}),
      ...(proxyToken ? { proxyToken } : {}),
      emit,
      ...(deps.now ? { now: deps.now } : {}),
    });
    killAgent = agent.kill;

    // Wall-clock budget (spec §2 `limits.wall_clock_ms`): a hung CLI must not
    // run forever while heartbeats keep the job looking alive.
    let wallClockExpired = false;
    const wallClockMs = spec.limits.wallClockMs;
    const nowIso = deps.now ?? (() => new Date().toISOString());
    if (wallClockMs > 0) {
      wallTimer = setTimeout(() => {
        wallClockExpired = true;
        log(`wall-clock budget exceeded (${String(wallClockMs)} ms) — terminating agent`);
        emit([
          {
            type: 'status',
            ts: nowIso(),
            payload: { state: 'budget_exceeded', limit: 'wallClockMs', limitMs: wallClockMs },
          },
        ]);
        killAgent?.('SIGTERM');
        graceTimer = setTimeout(() => killAgent?.('SIGKILL'), deps.killGraceMs ?? 10_000);
      }, wallClockMs);
    }

    const { code } = await agent.done;
    if (wallTimer) clearTimeout(wallTimer);
    if (graceTimer) clearTimeout(graceTimer);
    await postChain; // ensure every event batch has landed before the result

    if (wallClockExpired) {
      await safeResult(
        home,
        { outcome: 'failed', error: `wall-clock budget exceeded (${String(wallClockMs)} ms)` },
        log,
      );
      return 1;
    }
    if (cancelled) {
      await safeResult(home, { outcome: 'failed', error: 'job cancelled' }, log);
      return 1;
    }
    if (code !== 0) {
      await safeResult(home, { outcome: 'failed', error: `agent exited with code ${String(code)}` }, log);
      return 1;
    }

    // 5. Stage + diff. No push, ever.
    const diff = await collectDiff(gitOpts, repoDir);
    if (!diff.hasChanges) {
      await safeResult(home, { outcome: 'no_changes', summary: 'agent produced no file changes' }, log);
      return 0;
    }
    const artifactId = await home.postDiff(bundleDiff(diff.diff, diff.numstat));
    await safeResult(home, { outcome: 'diff_ready', diffArtifactId: artifactId }, log);
    return 0;
  } catch (err) {
    log(`shim failed: ${errText(err)}`);
    await safeResult(home, { outcome: 'failed', error: errText(err) }, log);
    return 1;
  } finally {
    clearInterval(heartbeat);
    if (wallTimer) clearTimeout(wallTimer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}

/** Best-effort terminal report — a failure to report must not mask the original. */
async function safeResult(home: HomeApi, result: RunnerResult, log: (l: string) => void): Promise<void> {
  try {
    await home.postResult(result);
  } catch (err) {
    log(`result post failed: ${errText(err)}`);
  }
}

function errText(err: unknown): string {
  if (err instanceof HomeError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// Entrypoint: run when invoked directly (the backend spawns this file). The
// backend sets OMADIA_PIPELINE_MODE=gated for a gated job → the W2 phase loop;
// otherwise the W0 collapsed path runs unchanged.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const env = readShimEnv();
  const run = env.pipelineMode === 'gated' ? runPhasedShim : runShim;
  run(env)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`[dev-runner-shim] fatal: ${errText(err)}\n`);
      process.exit(1);
    });
}
