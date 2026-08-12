/**
 * Dev-platform view types shared by the core dev-job surfaces.
 *
 * These used to live on the published `@omadia/plugin-api` surface because they
 * were the wire shape of `ctx.devJobs`. That accessor is gone (epic #470 —
 * `specs/470-dev-platform-plugin/dormant-capabilities.md` §2: zero providers,
 * zero consumers, threw on every call), so the types are no longer part of any
 * plugin contract. They stay CORE-LOCAL and travel with the dev-platform tree
 * when it moves to its own repo — deliberately NOT a new published package,
 * which would be the same speculative generality the accessor was.
 *
 * Consumers today: `devJobsHostService.ts`, `chatDevJobService.ts`,
 * `devJobOrchestratorTool.ts`.
 *
 * `DevJobKind` / `DevJobStatus` are NOT redefined here — `./types.ts` already
 * owns them as the single source of truth (derived from the `as const` arrays
 * that also back the runtime validators). They are re-exported so a consumer
 * needs one import for the whole descriptor vocabulary.
 */

export type { DevJobKind, DevJobStatus } from './types.js';

import type { DevJobKind, DevJobStatus } from './types.js';

/** Read-only projection of a dev job. Deliberately omits the creator, runner
 *  token, cost, and raw diff artifacts — the forge PR page is the review
 *  surface (epic non-goal). */
export interface DevJobDescriptor {
  readonly id: string;
  readonly repoId: string;
  readonly kind: DevJobKind;
  readonly status: DevJobStatus;
  readonly phase: string;
  readonly branch?: string;
  readonly prUrl?: string;
  readonly createdAt: string;
}

/** One entry of the append-only job event log, projected for a reader. */
export interface DevJobEventRecord {
  readonly id: number;
  /** Server-assigned ordering key (event timestamp, ISO 8601). */
  readonly at: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}
