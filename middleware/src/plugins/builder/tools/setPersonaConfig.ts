import { z } from 'zod';

import type { AgentSpecSkeleton } from '../types.js';
import {
  IllegalSpecState,
  applyJsonPatchesRaw,
  type JsonPatch,
} from '../specPatcher.js';
import type { BuilderTool } from './types.js';

/**
 * `set_persona_config` — Phase-3 Kemia builder tool (OB-67).
 *
 * Writes the per-profile persona block (template + 12 axes 0–100 +
 * free-text custom_notes) into `spec.persona` of the active draft.
 * The persisted shape is the inline mirror of `PersonaConfigSchema` in
 * `agentSpec.ts` and the canonical contract for Phase 4's
 * `personaCompose@1` provider plugin (conditional, deferred).
 *
 * Distinct from `patch_spec` for the same reason as `set_quality_config`:
 * the input is structured so the LLM doesn't have to reinvent the
 * pointer path. Replaces the entire persona block; pass `{}` to clear.
 */

// Tool-side input schema — same SHAPE as `PersonaConfigSchema` in
// agentSpec.ts but with the looser `axes` typing the LLM tool surface
// expects (record-of-numbers; unknown keys are dropped at runtime by
// the canonical Zod schema once the field flows through validation).
// The BuilderTool surface constrains `input: z.ZodType<I>` with a single
// type parameter, which conflicts with `.default(…)`/`ZodDefault`'s
// diverging input/output types — using `.optional()` keeps inference
// trivial, matching the `set_quality_config` pattern.
const InputSchema = z
  .object({
    template: z.string().min(1).optional(),
    axes: z
      .record(z.string().min(1), z.number().int().min(0).max(100))
      .optional(),
    custom_notes: z.string().max(2000).optional(),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface OkResult {
  ok: true;
  applied: JsonPatch[];
  /** Echo of the persisted block for the BuilderAgent's follow-up
   *  reasoning ("OK, directness is now 80"). */
  persona: Input;
}

interface ErrResult {
  ok: false;
  error: string;
}

type Result = OkResult | ErrResult;

const VALID_AXES = new Set<string>([
  'formality',
  'directness',
  'warmth',
  'humor',
  'sarcasm',
  'conciseness',
  'proactivity',
  'autonomy',
  'risk_tolerance',
  'creativity',
  'drama',
  'philosophy',
]);

export const setPersonaConfigTool: BuilderTool<Input, Result> = {
  id: 'set_persona_config',
  description:
    'Set the persona block on the draft AgentSpec (template + 12 axes 0-100 + custom_notes). ' +
    'Axes: formality, directness, warmth, humor, sarcasm, conciseness, proactivity, autonomy, ' +
    'risk_tolerance, creativity, drama, philosophy. Unknown axis names are dropped silently. ' +
    'This tool replaces any existing `spec.persona` block in full; pass an empty `{}` to clear it.',
  input: InputSchema,
  async run(input, ctx) {
    const draft = await ctx.draftStore.load(ctx.userEmail, ctx.draftId);
    if (!draft) {
      return { ok: false, error: `draft ${ctx.draftId} not found for user` };
    }

    // Filter unknown axis names. The canonical Zod schema is `.strict()`,
    // which would reject the whole call if the LLM hallucinates an axis;
    // dropping at the tool surface preserves partial-success ergonomics
    // (the operator gets the valid axes through, plus a hint via the
    // returned echo).
    const filteredAxes: Record<string, number> | undefined = input.axes
      ? Object.fromEntries(
          Object.entries(input.axes).filter(([k]) => VALID_AXES.has(k)),
        )
      : undefined;

    const sanitized: Input = {
      ...(input.template !== undefined ? { template: input.template } : {}),
      ...(filteredAxes && Object.keys(filteredAxes).length > 0
        ? { axes: filteredAxes }
        : {}),
      ...(input.custom_notes !== undefined
        ? { custom_notes: input.custom_notes }
        : {}),
    };

    const patches: JsonPatch[] = [
      { op: 'add', path: '/persona', value: sanitized },
    ];

    let nextSpec: AgentSpecSkeleton;
    try {
      nextSpec = applyJsonPatchesRaw(draft.spec, patches) as AgentSpecSkeleton;
    } catch (err) {
      const message = err instanceof IllegalSpecState ? err.message : String(err);
      return { ok: false, error: message };
    }

    await ctx.draftStore.update(ctx.userEmail, ctx.draftId, { spec: nextSpec });
    ctx.bus.emit(ctx.draftId, {
      type: 'spec_patch',
      patches: [...patches],
      cause: 'agent',
    });
    ctx.rebuildScheduler.schedule(ctx.userEmail, ctx.draftId);

    return {
      ok: true,
      applied: [...patches],
      persona: sanitized,
    };
  },
};
