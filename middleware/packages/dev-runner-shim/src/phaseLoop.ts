/**
 * Epic #470 W2 — the gated-pipeline phase loop (spec §4 "Per-phase runner
 * session lifecycle").
 *
 * A gated job runs over TWO provisions, each a separate container / shim
 * invocation. Provision A runs `analyze`, (`bootstrap`,) `plan`, `clarify` and
 * exits 0 at `park`; provision B (post-approval) re-clones the pinned tree and
 * runs `implement` and `review`. Within a provision the shim loops:
 *
 *   run the phase (a FRESH `claude -p` session, or the bootstrap COMMAND) →
 *   POST /phase-result → follow the engine's directive.
 *
 * The MIDDLEWARE decides every transition; the runner only reports what it did.
 * NOTHING is ever pushed; the middleware applies the diff server-side. Node
 * builtins only — no middleware import. The per-phase execution lives in
 * `phaseRunner.ts`; this file owns the lifecycle (spec/protocol gate, event
 * stream, heartbeat/cancel, wall clock, the loop).
 */

import { HomeClient, type HomeApi } from './homeClient.js';
import { cloneAtBaseSha, type GitOptions } from './gitOps.js';
import { PhaseRunner, absorb, errText, type Accumulated } from './phaseRunner.js';
import {
  RUNNER_PROTOCOL_VERSION,
  readShimEnv,
  type DevJobPhase,
  type PhaseResultBody,
  type RunnerEvent,
  type ShimEnv,
} from './protocol.js';

const HEARTBEAT_MS = 30_000;

export interface PhasedShimDeps {
  home?: HomeApi;
  gitBin?: string;
  now?: () => string;
  log?: (line: string) => void;
  /** SIGTERM→SIGKILL escalation window on a wall-clock / cancel kill. Test hook. */
  killGraceMs?: number;
}

/**
 * Run the gated phase loop for one provision. Returns the process exit code:
 * 0 on `park`/`done`, 1 on `failed` or any error.
 */
export async function runPhasedShim(
  env: ShimEnv = readShimEnv(),
  deps: PhasedShimDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => process.stderr.write(`[dev-runner-shim] ${l}\n`));
  const home = deps.home ?? new HomeClient(env);
  const nowIso = deps.now ?? (() => new Date().toISOString());

  // 1. Spec + protocol gate — identical posture to the W0 collapsed path.
  const spec = await home.fetchSpec();
  if (spec.protocol !== RUNNER_PROTOCOL_VERSION) {
    const message =
      `runner protocol mismatch: shim speaks v${String(RUNNER_PROTOCOL_VERSION)}, ` +
      `middleware sent v${String(spec.protocol)}`;
    log(message);
    return 1;
  }

  // 2. Serialized event sender (per-provision monotonic seq), mirroring runShim.
  let nextSeq = 0;
  let postChain: Promise<void> = Promise.resolve();
  const emit = (events: RunnerEvent[]): void => {
    if (events.length === 0) return;
    const stamped = events.map((e) => ({ ...e, seq: nextSeq++ }));
    postChain = postChain
      .then(() => home.postEvents(spec.provision, stamped))
      .then(() => undefined)
      .catch((err: unknown) => log(`event post failed: ${errText(err)}`));
  };

  // 3. Heartbeat + cancel + wall clock. A kill terminates the CURRENT phase's
  //    child; the killed session returns non-zero, the shim posts ok:false and
  //    the engine fails the job — so the loop needs no separate abort path.
  let cancelled = false;
  let wallExpired = false;
  let killCurrent: ((signal?: NodeJS.Signals) => void) | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  const setKill = (k: ((signal?: NodeJS.Signals) => void) | null): void => {
    killCurrent = k;
  };
  const heartbeat = setInterval(() => {
    void home
      .heartbeat()
      .then((reply) => {
        if (reply.cancelRequested && !cancelled) {
          cancelled = true;
          log('cancel requested — terminating current phase');
          killCurrent?.();
        }
      })
      .catch((err: unknown) => log(`heartbeat failed: ${errText(err)}`));
  }, HEARTBEAT_MS);

  const wallClockMs = spec.limits.wallClockMs;
  const wallTimer =
    wallClockMs > 0
      ? setTimeout(() => {
          wallExpired = true;
          log(`wall-clock budget exceeded (${String(wallClockMs)} ms) — terminating current phase`);
          emit([
            {
              type: 'status',
              ts: nowIso(),
              payload: { state: 'budget_exceeded', limit: 'wallClockMs', limitMs: wallClockMs },
            },
          ]);
          killCurrent?.('SIGTERM');
          graceTimer = setTimeout(() => killCurrent?.('SIGKILL'), deps.killGraceMs ?? 10_000);
        }, wallClockMs)
      : null;

  const gitOpts: GitOptions = {
    workspace: env.workspace,
    ...(deps.gitBin ? { gitBin: deps.gitBin } : {}),
    fetchToken: async () => (await home.fetchScmToken()).token,
    logger: log,
  };

  try {
    // 4. One clone per provision, at the pinned base sha (provision B re-clones
    //    the SAME base_sha the plan was approved against; the middleware pins it).
    const repoDir = await cloneAtBaseSha(gitOpts, spec.repo);

    // 5. Seed the accumulator. Provision B's cross-provision inputs (approved
    //    plan, gate answers, retry findings) arrive on the spec's phaseContext.
    const ctx = spec.phaseContext;
    const acc: Accumulated = {
      ...(ctx?.plan !== undefined ? { plan: ctx.plan } : {}),
      answers: ctx?.answers ?? [],
      attempt: ctx?.attempt ?? 0,
      priorFindings: ctx?.priorFindings ?? [],
    };

    // 6. The loop. Start at the phase the middleware put us at (A ⇒ 'analyze').
    let phase: DevJobPhase = ctx?.phase ?? 'analyze';
    let prevPhase: DevJobPhase | null = null;
    let sessionCount = 0;

    for (;;) {
      if (cancelled || wallExpired) {
        // A kill landed between phases: report the current one as failed so the
        // engine finalizes, then exit non-zero.
        const reason = wallExpired
          ? `wall-clock budget exceeded (${String(wallClockMs)} ms)`
          : 'job cancelled';
        await safePostPhase(home, { phase, ok: false, error: reason }, log);
        return 1;
      }

      emit([{ type: 'phase', ts: nowIso(), payload: { phase, state: 'start' } }]);

      const runner = new PhaseRunner({
        spec,
        env,
        repoDir,
        gitOpts,
        emit,
        acc,
        ...(deps.now ? { now: deps.now } : {}),
        setKill,
        session: () => sessionCount++,
      });
      const body = await runner.run(phase);
      setKill(null);

      // Absorb the phase's product into the accumulator for later phases.
      absorb(acc, phase, body);

      const directive = await home.postPhaseResult(body);
      emit([{ type: 'phase', ts: nowIso(), payload: { phase, state: 'reported', directive: directive.directive } }]);

      switch (directive.directive) {
        case 'park':
          log(`phase ${phase} → park; exiting 0 for the human gate`);
          return 0;
        case 'done':
          log(`phase ${phase} → done; exiting 0`);
          return 0;
        case 'failed':
          log(`phase ${phase} → failed: ${directive.reason}`);
          return 1;
        case 'next': {
          prevPhase = phase;
          phase = directive.phase;
          // A review→implement bounce is a retry round: bump the attempt so the
          // next implement session sees it (its findings are already on `acc`).
          if (phase === 'implement' && prevPhase === 'review') acc.attempt += 1;
          break;
        }
      }
    }
  } catch (err) {
    log(`phased shim failed: ${errText(err)}`);
    return 1;
  } finally {
    clearInterval(heartbeat);
    if (wallTimer) clearTimeout(wallTimer);
    if (graceTimer) clearTimeout(graceTimer);
    await postChain.catch(() => undefined);
  }
}

/** Best-effort terminal phase-result — a failure to report must not throw. */
async function safePostPhase(home: HomeApi, body: PhaseResultBody, log: (l: string) => void): Promise<void> {
  try {
    await home.postPhaseResult(body);
  } catch (err) {
    log(`phase-result post failed: ${errText(err)}`);
  }
}
