/**
 * #684 (epic #642) — the run trace is best-effort TELEMETRY, not a guaranteed
 * provenance record. This module records WHY a turn ended up without one.
 *
 * ## The decision, and why it went this way
 *
 * #650 put `model` and `provider` on the persisted Run node so a provenance
 * question about a past turn could be answered. #684 asked the question #650
 * deliberately left open: is that record *guaranteed*? It is not, and three
 * properties of the surrounding code say it should not be promised to be:
 *
 *  1. **The graph sink is optional by construction.** `SessionLogger` guards
 *     every ingest behind `if (this.graph)`; an operator can run omadia with no
 *     knowledge-graph plugin at all. A record that exists only when an optional
 *     subsystem happens to be installed cannot be the artefact a compliance
 *     answer rests on.
 *  2. **The Markdown transcript is the surface that IS guaranteed**, and the
 *     logger already says so: a failed transcript write skips graph ingest
 *     outright, "either both recorded the turn, or neither".
 *  3. **Guaranteeing the ingest would require auto-creating User-Cluster
 *     nodes**, which both knowledge-graph implementations refuse ON PURPOSE —
 *     "doing so would mask channel-resolution bugs by silently producing orphan
 *     clusters with no IS_IDENTITY_OF edges" (`neonKnowledgeGraph.ts`,
 *     `inMemoryKnowledgeGraph.ts`). Promoting the trace to a record would trade
 *     a gap that is visible for a data-integrity defect that is not.
 *
 * So: telemetry. The obligation that follows is not to make the trace complete
 * but to stop it being silently incomplete — which is what this module does,
 * and why `RunTrace` and `KnowledgeGraph.ingestRun` now say "telemetry" in
 * their own doc comments rather than leaving a reader to infer "audit receipt".
 *
 * ## What was actually invisible
 *
 * #684 described the drops as silent. Measured against the code, three of the
 * four paths already wrote a `console.error`; the genuinely invisible one is
 * **no graph sink configured**, which returned early with no signal at all. The
 * gap was therefore not "no logging" but "no single, greppable statement of the
 * outcome, and nothing that counts". Both are supplied here.
 */

/**
 * Why a collected run trace did or did not reach the graph. Every value except
 * {@link RUN_TRACE_RECORDED} means the turn happened but its trace did not
 * survive — the state a reader of the trace store must be able to distinguish
 * from "this turn never ran".
 */
export type RunTraceOutcome =
  /** The trace reached the graph. */
  | 'recorded'
  /** No knowledge-graph plugin is wired — nothing to write to. */
  | 'no-graph-sink'
  /** The Markdown transcript write failed, so graph ingest was skipped to keep
   *  the two surfaces consistent. */
  | 'transcript-failed'
  /** `ingestTurn` failed, so the Run would have pointed at a missing Turn. */
  | 'turn-ingest-failed'
  /** `ingestRun` itself threw — most commonly the missing User-Cluster node
   *  described in #684. */
  | 'run-ingest-failed';

/** The one outcome that is not a drop. `satisfies` rather than a type
 *  annotation on purpose: the annotation would widen this to `RunTraceOutcome`
 *  and an `=== RUN_TRACE_RECORDED` check would then narrow nothing. */
export const RUN_TRACE_RECORDED = 'recorded' satisfies RunTraceOutcome;

/** Monotonic per-outcome tallies since process start. */
export type RunTraceOutcomeCounts = Readonly<Record<RunTraceOutcome, number>>;

const ZERO_COUNTS: RunTraceOutcomeCounts = Object.freeze({
  recorded: 0,
  'no-graph-sink': 0,
  'transcript-failed': 0,
  'turn-ingest-failed': 0,
  'run-ingest-failed': 0,
});

/**
 * Process-local tallies of run-trace outcomes.
 *
 * Deliberately an injectable object rather than module-level mutable state: the
 * counters are asserted on in tests, and a shared global would make two tests
 * in one process read each other's turns. The kernel holds one instance; a test
 * constructs its own.
 */
export class RunTraceOutcomeStats {
  #counts: Record<RunTraceOutcome, number> = { ...ZERO_COUNTS };

  /** Tally one outcome. */
  record(outcome: RunTraceOutcome): void {
    this.#counts[outcome] += 1;
  }

  /** Immutable snapshot — callers cannot write back into the tally. */
  snapshot(): RunTraceOutcomeCounts {
    return Object.freeze({ ...this.#counts });
  }

  /** Total traces that were collected but never reached the graph. */
  droppedTotal(): number {
    return Object.entries(this.#counts).reduce(
      (acc, [outcome, n]) => (outcome === RUN_TRACE_RECORDED ? acc : acc + n),
      0,
    );
  }
}

/** Operator-facing explanation per drop reason. Kept next to the union so a new
 *  member cannot be added without a line a human can act on. */
const DROP_REASON_TEXT: Readonly<Record<Exclude<RunTraceOutcome, 'recorded'>, string>> =
  Object.freeze({
    'no-graph-sink':
      'no knowledge-graph plugin is configured — the run trace has nowhere to go; the Markdown transcript is unaffected',
    'transcript-failed':
      'the Markdown transcript write failed, so graph ingest was skipped to keep both surfaces consistent',
    'turn-ingest-failed':
      'ingestTurn failed, so the run trace was skipped rather than left pointing at a missing Turn',
    'run-ingest-failed':
      'ingestRun failed — most often no User-Cluster node exists for this user yet (see #684); channel identity is resolved only on the browser-login path',
  });

/**
 * Record one run-trace outcome: tally it, and — for every drop — emit ONE
 * greppable warn line naming the reason.
 *
 * `console.warn`, not `console.error`: a missing trace is a known, accepted
 * property of best-effort telemetry, and logging it at error level in a
 * deployment with no knowledge-graph plugin would flag every single turn as a
 * failure. The turn itself succeeded — that is the whole point of the decision.
 */
export function recordRunTraceOutcome(
  stats: RunTraceOutcomeStats,
  outcome: RunTraceOutcome,
  detail?: unknown,
): void {
  stats.record(outcome);
  if (outcome === RUN_TRACE_RECORDED) return;
  const suffix = detail === undefined ? '' : `: ${describe(detail)}`;
  console.warn(
    `[session-log] run trace not recorded (${outcome}) — ${DROP_REASON_TEXT[outcome]}${suffix}`,
  );
}

function describe(detail: unknown): string {
  return detail instanceof Error ? detail.message : String(detail);
}
