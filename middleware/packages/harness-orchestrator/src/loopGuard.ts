/**
 * LoopGuard — round-loop / no-progress detector for the agentic tool loop.
 *
 * The orchestrator runs up to `maxToolIterations` tool-calling iterations per
 * turn (raised to 100 so genuinely multi-step tasks can finish). The danger of
 * a high cap is a *round loop*: the model re-calling the same tool with the
 * same arguments, ignoring an identical result, and burning the whole budget
 * before failing. This guard catches that early.
 *
 * Signal model — per iteration we hash the **batch** of tool calls the model
 * emitted (tool name + canonical-JSON of its input, order-independent) and the
 * **results** that batch produced. The strongest loop signal is *identical
 * arguments AND identical results*: the model learned nothing and is spinning.
 * A paginated / parametrised tool called with *different* args yields a
 * different signature and never trips, so honest multi-step work keeps its full
 * iteration headroom.
 *
 * Decision ladder for a repeating (args+results) batch:
 *   - `softRepeat` (default 3) → `nudge`: inject a steer telling the model to
 *     stop repeating and either change approach or finalise. Emitted once per
 *     signature so the model is not spammed.
 *   - `hardRepeat` (default 5) → `stop`: give up on tools and force a
 *     best-effort final answer (the orchestrator's finalize path).
 *
 * Pure and dependency-free — unit-tested in isolation (loopGuard.test.ts).
 */

/** Minimal shape of a model tool-call this guard inspects. */
export interface ToolUseLike {
  readonly name: string;
  readonly input: unknown;
}

/** Minimal shape of a tool result this guard inspects. */
export interface ToolResultLike {
  /** Result payload — string in both orchestrator loops, but typed loosely. */
  readonly content: unknown;
  readonly isError?: boolean;
}

export interface LoopGuardOptions {
  /** Repeats of an identical (args+results) batch that trigger a nudge. */
  readonly softRepeat?: number;
  /** Repeats that force a stop → best-effort finalize. */
  readonly hardRepeat?: number;
}

export type LoopGuardAction = 'continue' | 'nudge' | 'stop';

export interface LoopGuardDecision {
  readonly action: LoopGuardAction;
  /** Diagnostic — why the guard reacted (for logs / run trace). */
  readonly reason?: string;
  /** Steer text to inject into the conversation when `action === 'nudge'`. */
  readonly nudge?: string;
  /** Times this (args+results) signature has now been observed. */
  readonly repeats?: number;
}

const CONTINUE: LoopGuardDecision = { action: 'continue' };

/**
 * Canonical JSON: object keys sorted recursively so `{a:1,b:2}` and
 * `{b:2,a:1}` hash identically. Arrays keep order (it is semantically
 * meaningful). Falls back to `String(value)` for anything non-serialisable
 * (circular refs, BigInt) so signing never throws inside the hot loop.
 */
export function canonicalize(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(val as Record<string, unknown>).sort()) {
          sorted[k] = (val as Record<string, unknown>)[k];
        }
        return sorted;
      }
      return val;
    }) ?? 'null';
  } catch {
    return String(value);
  }
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  return canonicalize(content);
}

/**
 * Order-independent signature of the batch's (call → result) pairs. Each tool
 * use is paired to its positionally-aligned result (both orchestrator loops
 * build `toolResults[i]` from `toolUses[i]`), encoded as `name(args)⇒result`,
 * then sorted so the same batch emitted in a different order hashes
 * identically. Identical args AND identical results is the loop signal.
 */
function comboSignature(
  toolUses: readonly ToolUseLike[],
  toolResults: readonly ToolResultLike[],
): string {
  return toolUses
    .map((u, i) => {
      const result = toolResults[i];
      const out = result ? contentToString(result.content) : '';
      return `${u.name}(${canonicalize(u.input)})⇒${out}`;
    })
    .sort()
    .join(' ');
}

function buildNudge(toolUses: readonly ToolUseLike[], repeats: number): string {
  const names = [...new Set(toolUses.map((u) => u.name))].join(', ');
  return (
    `You have already called \`${names}\` with identical arguments ${repeats} ` +
    `times and received the same result each time. Repeating it will not make ` +
    `progress. Either take a materially different approach (different ` +
    `arguments or a different tool), or stop calling tools and give your best ` +
    `final answer now using the information you already have.`
  );
}

export class LoopGuard {
  private readonly soft: number;
  private readonly hard: number;
  /** (args+results) signature → times observed. */
  private readonly comboCounts = new Map<string, number>();
  /** Signatures already nudged, so a nudge fires at most once each. */
  private readonly nudged = new Set<string>();

  constructor(opts: LoopGuardOptions = {}) {
    // soft ≥ 2 (a single repeat is too eager); hard strictly above soft.
    this.soft = Math.max(2, Math.trunc(opts.softRepeat ?? 3));
    this.hard = Math.max(this.soft + 1, Math.trunc(opts.hardRepeat ?? 5));
  }

  /**
   * Record one iteration's tool batch + its results and decide what to do.
   * Empty batches (no tool calls) are always `continue`.
   */
  record(
    toolUses: readonly ToolUseLike[],
    toolResults: readonly ToolResultLike[],
  ): LoopGuardDecision {
    if (toolUses.length === 0) return CONTINUE;

    const combo = comboSignature(toolUses, toolResults);
    const repeats = (this.comboCounts.get(combo) ?? 0) + 1;
    this.comboCounts.set(combo, repeats);

    if (repeats >= this.hard) {
      return {
        action: 'stop',
        repeats,
        reason: `identical tool batch + result repeated ${repeats}× (hard cap ${this.hard})`,
      };
    }
    if (repeats >= this.soft && !this.nudged.has(combo)) {
      this.nudged.add(combo);
      return {
        action: 'nudge',
        repeats,
        nudge: buildNudge(toolUses, repeats),
        reason: `identical tool batch + result repeated ${repeats}× (soft cap ${this.soft})`,
      };
    }
    return CONTINUE;
  }
}
