import { z } from 'zod';

import { loadBoilerplate } from '../boilerplateSource.js';
import type { BuildError } from '../buildErrorParser.js';
import type { SlotTypecheckReason } from '../slotTypecheckPipeline.js';
import { annotateAll } from '../tscErrorHints.js';
import type { BuilderTool } from './types.js';

/**
 * Validate a slot key against the template's slot declarations when it
 * looks like a partial of a declared slot (`<base>-<n>`). Direct hits on
 * declared slot keys, and keys that don't match the partial shape, pass
 * through unchanged — preserving today's lenient behaviour for ad-hoc
 * slot keys. Only out-of-range partial indices are rejected, since the
 * partial-slot contract (`max_partials`) is what codegen relies on to
 * know which files to synthesise.
 */
async function validatePartialKeyShape(
  slotKey: string,
  templateId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let bundle;
  try {
    bundle = await loadBoilerplate(templateId);
  } catch {
    return { ok: true };
  }
  if (bundle.manifest.slots.some((s) => s.key === slotKey)) return { ok: true };
  const m = /^(.+)-(\d+)$/.exec(slotKey);
  if (!m) return { ok: true };
  const base = m[1] ?? '';
  const n = Number(m[2]);
  const baseSlot = bundle.manifest.slots.find((s) => s.key === base);
  if (!baseSlot) return { ok: true };
  if (n < 1 || baseSlot.max_partials < n) {
    return {
      ok: false,
      error:
        `Slot '${slotKey}' looks like a partial of '${base}' but template ` +
        `'${templateId}' declares max_partials=${String(baseSlot.max_partials)} ` +
        `for that slot. Use indices in [1, ${String(baseSlot.max_partials)}], ` +
        `or fill the base slot '${base}' instead.`,
    };
  }
  return { ok: true };
}

const InputSchema = z
  .object({
    slotKey: z
      .string()
      .min(1, 'slotKey must be non-empty')
      .max(120, 'slotKey too long')
      .regex(
        /^[a-z][a-z0-9-]*$/,
        'slotKey must be kebab-case (lowercase, digits, dashes; start with a letter)',
      ),
    source: z.string().min(1, 'source must be non-empty'),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface OkResult {
  ok: true;
  slotKey: string;
  bytes: number;
  /** Tsc gate latency in ms (B.7-2). */
  typecheckMs: number;
}
interface ErrResult {
  ok: false;
  /** Human-readable reason — used by the LLM to decide whether/how to retry. */
  error: string;
  /** Slot was still persisted iff slotKey/draftId resolved (B.7 resolution #3). */
  slotKey?: string;
  bytes?: number;
  /**
   * Structured tsc errors when reason='tsc'. Capped at the first 50 by the
   * pipeline so a 70+-error blow-up doesn't fill the agent's context window.
   * Surfaced verbatim so the agent can map error.path/line/code to the slot
   * source it just wrote.
   */
  tscErrors?: BuildError[];
  /** Mirrors SlotTypecheckResult.reason — useful for tests + telemetry. */
  reason?: SlotTypecheckReason;
  typecheckMs?: number;
}
type Result = OkResult | ErrResult;

const MAX_INLINE_ERRORS = 5;
/** Threshold that triggers a single `agent_stuck` SSE event per (draftId, slotKey, turn). */
const AGENT_STUCK_THRESHOLD = 3;

export const fillSlotTool: BuilderTool<Input, Result> = {
  id: 'fill_slot',
  description:
    'Set the source code for a named slot in the draft. Slots are the LLM-' +
    'authored code chunks that the codegen engine injects into marker regions ' +
    'inside the boilerplate template. Use this for activate-body, tool-handlers, ' +
    'helper-functions, etc. After write, the tool runs `tsc --noEmit` against the ' +
    'freshly codegen-ed staging dir and returns ok=false with the tsc errors if ' +
    'the project does not typecheck — re-call fill_slot with a corrected source ' +
    'to fix them. The slot is persisted regardless of the gate result so the user ' +
    'sees it in the editor with Monaco markers. Idempotent — re-calling overwrites ' +
    'the previous source.',
  input: InputSchema,
  async run({ slotKey, source }, ctx) {
    const draft = await ctx.draftStore.load(ctx.userEmail, ctx.draftId);
    if (!draft) {
      return { ok: false, error: `draft ${ctx.draftId} not found for user` };
    }

    if (draft.spec.template) {
      const partialCheck = await validatePartialKeyShape(slotKey, draft.spec.template);
      if (!partialCheck.ok) {
        return { ok: false, error: partialCheck.error };
      }
    }

    const nextSlots: Record<string, string> = { ...draft.slots, [slotKey]: source };
    await ctx.draftStore.update(ctx.userEmail, ctx.draftId, { slots: nextSlots });

    ctx.bus.emit(ctx.draftId, {
      type: 'slot_patch',
      slotKey,
      source,
      cause: 'agent',
    });

    // tsc-gate (B.7-2). Slot is already persisted; we only decide whether
    // to schedule a rebuild and what to surface back to the agent.
    const tc = await ctx.slotTypechecker.run({
      userEmail: ctx.userEmail,
      draftId: ctx.draftId,
    });

    if (!tc.ok) {
      // Annotate tsc errors with Builder-specific hints (B.7-5) so the
      // agent sees actionable guidance ("ToolDescriptor needs <I, O>")
      // alongside the bare tsc message in BOTH the structured array and
      // the formatted error string.
      const annotatedErrors = annotateAll(tc.errors);

      // Track the failure (B.7-4). When the per-turn attempt count
      // crosses the threshold for the first time, emit `agent_stuck` so
      // the frontend can surface a manual-intervention banner. Subsequent
      // failures past the threshold keep counting but don't re-emit.
      const attempts = ctx.slotRetryTracker.recordFail(slotKey);
      if (attempts === AGENT_STUCK_THRESHOLD) {
        ctx.bus.emit(ctx.draftId, {
          type: 'agent_stuck',
          slotKey,
          attempts,
          lastReason: tc.reason,
          lastSummary: tc.summary,
          lastErrorCount: annotatedErrors.length,
        });
      }

      // Track *consecutive* failures across all slots in this turn. When
      // the budget is exhausted, surface a hard-stop error — the bridge
      // converts `Error:`-prefix into a stop signal for the LocalSubAgent.
      const consecutiveFails = ctx.buildFailureBudget.recordFail();
      if (consecutiveFails >= ctx.buildFailureBudget.limit) {
        return {
          ok: false,
          slotKey,
          bytes: source.length,
          error: formatBudgetExhausted(
            consecutiveFails,
            ctx.buildFailureBudget.limit,
            tc.summary,
            annotatedErrors,
          ),
          tscErrors: annotatedErrors,
          reason: tc.reason,
          typecheckMs: tc.durationMs,
        };
      }

      // Skip the preview rebuild — same errors would surface there and waste
      // a build cycle. Slot stays persisted so Monaco can highlight it (B.6-13.2).
      return {
        ok: false,
        slotKey,
        bytes: source.length,
        error: formatGateError(tc.summary, annotatedErrors),
        tscErrors: annotatedErrors,
        reason: tc.reason,
        typecheckMs: tc.durationMs,
      };
    }

    // Reset the per-slot retry counter and the cross-slot consecutive
    // budget — a green slot proves the agent isn't stuck, so subsequent
    // failures should start counting from zero again.
    ctx.slotRetryTracker.reset(slotKey);
    ctx.buildFailureBudget.reset();
    ctx.rebuildScheduler.schedule(ctx.userEmail, ctx.draftId);
    return { ok: true, slotKey, bytes: source.length, typecheckMs: tc.durationMs };
  },
};

/**
 * Formats the budget-exhausted error so the LLM gets the original tsc
 * detail PLUS an explicit stop instruction — without the latter the
 * model may attempt one more `fill_slot` even past the cap.
 */
function formatBudgetExhausted(
  consecutiveFails: number,
  limit: number,
  summary: string,
  errors: BuildError[],
): string {
  return (
    `Build-Budget erschöpft: ${String(consecutiveFails)} aufeinanderfolgende ` +
    `slot-typecheck-Failures ohne dazwischenliegenden Erfolg (Limit: ${String(limit)}). ` +
    `Stoppe jetzt mit fill_slot. Antworte dem User mit dem letzten ` +
    `tsc-Fehler und frage nach Klarstellung — z.B. ob die genutzte ` +
    `Library-API überhaupt korrekt ist.\n\n` +
    `Letzter Fehler: ${formatGateError(summary, errors)}`
  );
}

function formatGateError(summary: string, errors: BuildError[]): string {
  if (errors.length === 0) return summary;
  const head = errors
    .slice(0, MAX_INLINE_ERRORS)
    .map((e) => `${e.path}(${String(e.line)},${String(e.col)}): ${e.code}: ${e.message}`)
    .join('\n');
  const overflow = errors.length > MAX_INLINE_ERRORS
    ? `\n... and ${String(errors.length - MAX_INLINE_ERRORS)} more error(s) — see tscErrors[] for full list`
    : '';
  return `${summary}:\n${head}${overflow}`;
}
