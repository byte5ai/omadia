/**
 * Epic #470 W0 — the `RunnerBackend` seam (spec §3/§4).
 *
 * The canonical wire shapes (`RunnerBackend`, `RunnerHandle`,
 * `DevJobProvisionInput`) live in `./types.ts` next to the rest of the
 * DB-mirrored contract; this module is the backend-facing entry point. It
 * re-exports the seam so backends and the worker import ONE module, and adds
 * the two things only backends need:
 *
 *   - `DevJobProvisionContext` — `provision()` deliberately receives pointers,
 *     not secrets (the runner pulls its own spec), but a backend must still be
 *     able to REFUSE a job it may not run. The context carries exactly the two
 *     admission facts that decision needs (`source`, `repo.runsTests`) and
 *     nothing else. The worker supplies them from the claimed job + repo row;
 *     a backend fails closed when they are missing (see
 *     `assertProvisionContext`), so a caller cannot skip admission by passing
 *     the bare pointer shape.
 *
 *   - `RunnerBackendError` — a typed refusal. Backends live below the HTTP
 *     layer, so this is NOT the routes' `DevPlatformError` (no status code);
 *     callers map `code` to a transport error themselves. Codes share the
 *     `devplatform.` prefix used everywhere else.
 */

import type { DevJobProvisionInput, DevJobSource } from './types.js';

export type {
  DevJobProvisionInput,
  RunnerBackend,
  RunnerBackendKind,
  RunnerHandle,
} from './types.js';
export { RUNNER_BACKEND_KINDS, isRunnerBackendKind } from './types.js';

/**
 * What the worker hands `provision()`: the phone-home pointers plus the
 * admission facts a backend refuses on (spec §5 — the local backend refuses
 * `runs_tests = true` repos and any non-admin source at its own boundary,
 * independent of the route-level check in `devPlatformShared.ts`).
 */
export interface DevJobProvisionContext extends DevJobProvisionInput {
  source: DevJobSource;
  repo: { runsTests: boolean };
}

/** A typed backend refusal/failure. `code` uses the `devplatform.` prefix. */
export class RunnerBackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RunnerBackendError';
    this.code = code;
  }
}

/**
 * Fail-closed guard: a backend that enforces admission cannot accept an input
 * whose admission facts are absent or malformed (e.g. a JS caller passing the
 * bare `DevJobProvisionInput`). Throws `devplatform.admission_context_missing`.
 */
export function assertProvisionContext(
  input: DevJobProvisionInput | DevJobProvisionContext,
): asserts input is DevJobProvisionContext {
  const ctx = input as Partial<DevJobProvisionContext>;
  if (typeof ctx.source !== 'string' || typeof ctx.repo?.runsTests !== 'boolean') {
    throw new RunnerBackendError(
      'devplatform.admission_context_missing',
      'provision() requires the admission context (source, repo.runsTests) — refusing to run unverified',
    );
  }
}
