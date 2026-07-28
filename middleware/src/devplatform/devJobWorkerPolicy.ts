/**
 * Epic #470 W0 — pure policy + wire helpers for the {@link DevJobWorker}, split
 * out of `devJobWorker.ts` to keep that file under the repo's 500-line guideline.
 * Nothing here holds state or touches the store; each function is a stateless
 * decision that is unit-tested on its own. The worker re-exports these so the
 * public surface (`devJobWorker.js`) is unchanged for callers and tests.
 */

import type { DevJobAuthMode, DevJobSource, DevJobStatus, RunnerBackendKind } from './types.js';

// --- Diff bundle wire split (spec §8) --------------------------------------

// The runner uploads `<unified diff><marker><numstat>` as ONE `diff` artifact;
// the host-side apply needs the halves separately to cross-check them. This
// marker MUST equal the shim's `NUMSTAT_MARKER`
// (`packages/dev-runner-shim/src/diffUpload.ts`) — a cross-package wire constant,
// bare/unprefixed so it cannot occur inside a unified diff. See the spec-delta note.
export const NUMSTAT_MARKER = '\n===OMADIA-DEV-RUNNER-NUMSTAT-V1===\n';

/** Inverse of the shim's `bundleDiff`. Marker absent ⇒ the whole body is the
 *  diff and the numstat is empty (a numstat-less diff fails the apply's
 *  cross-check loudly rather than silently applying an unverified change). */
export function splitDiffBundle(bundle: string): { diff: string; numstat: string } {
  const at = bundle.indexOf(NUMSTAT_MARKER);
  if (at === -1) return { diff: bundle, numstat: '' };
  return { diff: bundle.slice(0, at), numstat: bundle.slice(at + NUMSTAT_MARKER.length) };
}

// --- Worker refusal --------------------------------------------------------

/** A typed worker refusal. Lives below the HTTP layer (unlike the routes'
 *  `DevPlatformError`), so it carries a `devplatform.` code but no status. */
export class DevJobWorkerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DevJobWorkerError';
    this.code = code;
  }
}

// --- Runner-liveness scope -------------------------------------------------

/**
 * `applying` is the one active status with no live runner: the runner posted its
 * diff and exited 0 BY DESIGN, and the host now commits it. Runner-liveness
 * enforcement — reap, stale-heartbeat, wall-clock — MUST skip an `applying` job,
 * or a normally-completed apply is pre-empted and finalized `stalled` /
 * `budget_exceeded`, stranding the PR (epic #470's core guarantee) with no way
 * to retry. Terminal statuses never reach these paths (the store's active reads
 * exclude them), so this single carve-out is the whole rule.
 */
export function isHostSideApplyPhase(status: DevJobStatus): boolean {
  return status === 'applying';
}

// --- Auth-mode admission (spec §6b / Q4) -----------------------------------
// The worker half of the route's `assertAuthModeAdmissible`: the same decision,
// expressed below the HTTP layer as a typed `DevJobWorkerError` (no status).
// Exported so a test can drive the non-admin / flag-unset branches directly.

/**
 * Subscription jobs run the CLI on the operator's Claude login, so the
 * credential IS inside the runner — admitted only where no repository code can
 * execute beside it: subscription mode on, a no-exec repo, an operator-initiated
 * job, and never the (W4) fly backend. A capability gate, not a trust gate.
 */
export function assertAuthModeAdmissible(
  job: { authMode: DevJobAuthMode; source: DevJobSource; backend: RunnerBackendKind },
  repo: { runsTests: boolean },
  cfg: { subscriptionModeEnabled: boolean },
): void {
  if (job.authMode !== 'subscription') return;
  if (!cfg.subscriptionModeEnabled) {
    throw new DevJobWorkerError('devplatform.subscription_disabled', 'subscription auth mode is disabled');
  }
  if (repo.runsTests) {
    throw new DevJobWorkerError(
      'devplatform.subscription_requires_no_exec',
      'subscription auth mode requires a repo whose tests do not execute',
    );
  }
  if (job.source !== 'admin') {
    throw new DevJobWorkerError('devplatform.subscription_operator_only', 'subscription auth mode is admin-only');
  }
  if (job.backend === 'fly') {
    throw new DevJobWorkerError(
      'devplatform.subscription_backend_unsupported',
      'subscription auth mode is not supported on the fly backend',
    );
  }
}
