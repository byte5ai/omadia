import type { UpdateStatus, UpdaterFailure, UpdaterPhase } from '../../../_lib/api';

/**
 * Shared decoding of the updater's structured outcome, used by both the
 * progress modal and the page-level banner so the two never disagree.
 *
 * Everything here is pure and deterministic — it is the part of the update UX
 * worth unit-testing without a DOM.
 */

/** The stepper's rows, in job order. `rollback` is not a row: it replaces the
 *  tail of the sequence when the job reverts. */
export const UPDATE_STEPS: readonly Exclude<UpdaterPhase, 'rollback' | 'done'>[] = [
  'resolve',
  'preflight',
  'pin',
  'replace',
  'health_gate',
];

export type StepState = 'done' | 'current' | 'pending' | 'failed';

/**
 * Maps the sidecar's phase onto a per-row state. A `null` phase while updating
 * (older sidecar) marks nothing current — the modal then shows the generic
 * in-progress line instead of a lying stepper.
 */
export function stepStates(
  phase: UpdaterPhase | null | undefined,
  failure: UpdaterFailure | null | undefined,
  terminal: boolean,
  /** The job ended in `failed` (threw, no rollback) without a structured
   *  failure — e.g. an unpullable image in `preflight`. The row the job was
   *  in is then the failed one; without this it would render as done. */
  failedWithoutReason = false,
): Record<(typeof UPDATE_STEPS)[number], StepState> {
  const out = {} as Record<(typeof UPDATE_STEPS)[number], StepState>;
  const phaseRow =
    phase !== null && phase !== undefined && (UPDATE_STEPS as readonly string[]).includes(phase)
      ? (phase as (typeof UPDATE_STEPS)[number])
      : null;
  const failedAt: (typeof UPDATE_STEPS)[number] | null =
    failure?.kind === 'health_gate' ? 'health_gate'
    : failure?.kind === 'replace' ? 'replace'
    : terminal && failedWithoutReason ? phaseRow
    : null;
  // `done` and `rollback` sit past the last row; everything before the phase
  // is finished.
  const phaseIndex =
    phase === null || phase === undefined ? -1
    : phase === 'done' || phase === 'rollback' ? UPDATE_STEPS.length
    : UPDATE_STEPS.indexOf(phase);
  UPDATE_STEPS.forEach((step, i) => {
    if (failedAt !== null && step === failedAt) {
      out[step] = 'failed';
    } else if (failedAt !== null && i > UPDATE_STEPS.indexOf(failedAt)) {
      out[step] = 'pending';
    } else if (i < phaseIndex || (terminal && failedAt === null && phaseIndex >= i)) {
      out[step] = 'done';
    } else if (i === phaseIndex && !terminal) {
      out[step] = 'current';
    } else {
      out[step] = 'pending';
    }
  });
  return out;
}

export type DecodedFailure =
  | { kind: 'never_reachable' }
  | { kind: 'version_never_matched'; observedVersion: string }
  | { kind: 'replace'; service: string | null }
  | { kind: 'unknown'; message: string };

/**
 * Turns the structured failure (or, on an older sidecar, the raw error
 * string) into one of a handful of cases the catalog has words for.
 */
export function decodeFailure(
  failure: UpdaterFailure | null | undefined,
  error: string | undefined,
): DecodedFailure {
  if (failure?.kind === 'health_gate') {
    if (failure.reason === 'never_reachable') return { kind: 'never_reachable' };
    if (failure.reason === 'version_never_matched') {
      return {
        kind: 'version_never_matched',
        observedVersion: failure.observedVersion ?? '?',
      };
    }
    return { kind: 'unknown', message: error ?? failure.reason };
  }
  if (failure?.kind === 'replace') return { kind: 'replace', service: failure.service };
  // Older sidecar: the only signal is the English trail line.
  if (error !== undefined && /never_reachable/.test(error)) return { kind: 'never_reachable' };
  return { kind: 'unknown', message: error ?? '' };
}

export type Outcome = 'running' | 'succeeded' | 'rolled_back' | 'failed';

export interface InflightUpdate {
  readonly target: string;
  readonly previous: string | null;
  /** Epoch ms when this browser issued the trigger. */
  readonly startedAt: number;
}

/**
 * Whether the sidecar status describes THIS update and not an earlier run.
 * The sidecar keeps its last job around until the next one starts, so a
 * `rolled_back` from last week must not close a modal that was just opened.
 * Clock skew between browser and sidecar is tolerated generously: a job that
 * started within the last minute before our click is still ours.
 */
const CLOCK_SKEW_MS = 60_000;
export function describesThisRun(
  executor: UpdateStatus['executor'] | undefined,
  inflight: InflightUpdate,
): boolean {
  if (!executor?.reachable) return false;
  if (executor.targetVersion !== inflight.target) return false;
  // A job that FINISHED before this click is a previous job, full stop — this
  // is what catches a retry of the same target within the skew window after a
  // fast `replace` failure.
  if (typeof executor.finishedAt === 'string') {
    const finished = Date.parse(executor.finishedAt);
    if (!Number.isNaN(finished) && finished < inflight.startedAt) return false;
  }
  if (typeof executor.startedAt !== 'string') return true;
  const started = Date.parse(executor.startedAt);
  return Number.isNaN(started) || started >= inflight.startedAt - CLOCK_SKEW_MS;
}

/** The single source of truth for "is it over, and how did it end". */
export function deriveOutcome(
  status: UpdateStatus | null,
  inflight: InflightUpdate,
): Outcome {
  if (status === null) return 'running';
  // The restart is over once the running build IS the target — true even if
  // the sidecar is unreachable or predates `state` bookkeeping.
  if (status.current.version === inflight.target) return 'succeeded';
  const ex = status.executor;
  if (!describesThisRun(ex, inflight)) return 'running';
  if (ex.state === 'rolled_back') return 'rolled_back';
  if (ex.state === 'failed') return 'failed';
  if (ex.state === 'succeeded') return 'succeeded';
  return 'running';
}
