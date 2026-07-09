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

import { HomeClient, HomeError, type HomeApi } from './homeClient.js';
import { cloneAtBaseSha, collectDiff, type GitOptions } from './gitOps.js';
import { bundleDiff } from './diffUpload.js';
import { runAgent } from './agentRunner.js';
import {
  RUNNER_PROTOCOL_VERSION,
  readShimEnv,
  type RunnerEvent,
  type RunnerResult,
  type ShimEnv,
} from './protocol.js';

const HEARTBEAT_MS = 30_000;

export interface ShimDeps {
  home?: HomeApi;
  gitBin?: string;
  now?: () => string;
  log?: (line: string) => void;
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
  let killAgent: (() => void) | null = null;
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
    const proxyBaseUrl = process.env['OMADIA_ANTHROPIC_BASE_URL']?.trim();
    const proxyToken = process.env['OMADIA_ANTHROPIC_AUTH_TOKEN']?.trim();
    const agent = runAgent({
      cliBin: env.cliBin,
      cwd: repoDir,
      spec,
      ...(proxyBaseUrl ? { proxyBaseUrl } : {}),
      ...(proxyToken ? { proxyToken } : {}),
      emit,
      ...(deps.now ? { now: deps.now } : {}),
    });
    killAgent = agent.kill;
    const { code } = await agent.done;
    await postChain; // ensure every event batch has landed before the result

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

// Entrypoint: run when invoked directly (the backend spawns this file).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runShim()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`[dev-runner-shim] fatal: ${errText(err)}\n`);
      process.exit(1);
    });
}
