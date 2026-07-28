import type { DevJobPhase } from '../types.js';

/**
 * Epic #470 W2 — the phased-pipeline transition table (spec §4), as a PURE
 * function. The stateful engine (persistence, artifacts, directives, token
 * revocation) wraps this; the decision of "given the current phase and this
 * runner result, what happens next" lives here alone so the whole table is one
 * exhaustively-testable unit.
 *
 * The middleware, never the runner, decides transitions. The runner POSTs a
 * phase result; this computes the outcome.
 */

/** A result the runner POSTs for the phase it just ran. */
export interface PhaseResult {
  phase: DevJobPhase;
  ok: boolean;
  /** clarify emits questions (may be empty); review emits a verdict. */
  hasQuestions?: boolean;
  reviewVerdict?: 'approve' | 'request_changes';
  /** review only: true when the loop is not converging (fingerprint repeated or
   *  attempts exhausted) → proceed to pr with findings annotated. */
  reviewLoopExhausted?: boolean;
}

export type PipelineMode = 'gated' | 'collapsed';

export interface TransitionContext {
  mode: PipelineMode;
  /** kind === 'analyze' jobs terminate after analyze regardless of mode. */
  kind: 'analyze' | 'fix_issue' | 'implement';
}

/** What the engine must do next. */
export type Transition =
  | { kind: 'advance'; to: DevJobPhase; sameProvision: boolean }
  | { kind: 'park' } //   gate opened; the runner exits, resumes in a fresh provision
  | { kind: 'requeue'; to: DevJobPhase } // re-queue at a pinned base (await_human→implement)
  | { kind: 'retry_implement' } //         review requested changes, loop continues
  | { kind: 'done' } //                    terminal success; host-side pr already/next
  | { kind: 'fail'; reason: string }; //   protocol violation or ok:false

/**
 * The gated-mode order. Collapsed skips plan/clarify/await_human.
 */
const GATED_ORDER: DevJobPhase[] = [
  'analyze',
  'bootstrap',
  'plan',
  'clarify',
  'await_human',
  'implement',
  'review',
  'pr',
];

const COLLAPSED_ORDER: DevJobPhase[] = ['analyze', 'implement', 'review', 'pr'];

/**
 * Compute the transition for a phase result. Throws nothing — an invalid result
 * yields a `fail` transition so the caller has one code path.
 */
export function computeTransition(result: PhaseResult, ctx: TransitionContext): Transition {
  if (!result.ok) {
    return { kind: 'fail', reason: `phase ${result.phase} reported failure` };
  }

  // An analyze-kind job runs analyze then stops, whatever the mode.
  if (ctx.kind === 'analyze') {
    return result.phase === 'analyze' ? { kind: 'done' } : { kind: 'fail', reason: 'analyze job ran a non-analyze phase' };
  }

  switch (result.phase) {
    case 'analyze':
      return { kind: 'advance', to: ctx.mode === 'gated' ? 'bootstrap' : 'implement', sameProvision: true };

    case 'bootstrap':
      // bootstrap only exists in gated mode (collapsed skips it).
      return { kind: 'advance', to: 'plan', sameProvision: true };

    case 'plan':
      return { kind: 'advance', to: 'clarify', sameProvision: true };

    case 'clarify':
      // The gate always opens in gated mode; with zero questions it is
      // approval-only. The runner exits at the park — nothing idles on the human.
      return { kind: 'park' };

    case 'await_human':
      // Reached only via gate resolution (approved). Re-queue: the claim loop
      // re-provisions at the pinned base_sha for the implement session.
      return { kind: 'requeue', to: 'implement' };

    case 'implement':
      return { kind: 'advance', to: 'review', sameProvision: true };

    case 'review': {
      if (result.reviewVerdict === 'approve') {
        return { kind: 'advance', to: 'pr', sameProvision: true };
      }
      if (result.reviewVerdict === 'request_changes') {
        // Exhausted (fingerprint identical or attempts spent) → proceed to pr
        // with findings annotated; otherwise loop back to implement.
        return result.reviewLoopExhausted
          ? { kind: 'advance', to: 'pr', sameProvision: true }
          : { kind: 'retry_implement' };
      }
      return { kind: 'fail', reason: 'review produced no verdict' };
    }

    case 'pr':
      // pr is host-only; a runner should never report it. But if a caller drives
      // the host pr step through here, it terminates the job.
      return { kind: 'done' };

    default:
      return { kind: 'fail', reason: `unknown phase ${String(result.phase)}` };
  }
}

/** The ordered phase list for a mode — used by the UI's phase rail and tests. */
export function phaseOrder(mode: PipelineMode): DevJobPhase[] {
  return mode === 'gated' ? [...GATED_ORDER] : [...COLLAPSED_ORDER];
}

/** Is `to` a forward move from `from` in this mode? Guards against replay/stale results. */
export function isForward(from: DevJobPhase, to: DevJobPhase, mode: PipelineMode): boolean {
  const order = phaseOrder(mode);
  return order.indexOf(to) > order.indexOf(from);
}
