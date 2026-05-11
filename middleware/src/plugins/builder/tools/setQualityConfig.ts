import { z } from 'zod';

import { SycophancyLevelSpecSchema } from '../agentSpec.js';
import type { AgentSpecSkeleton } from '../types.js';
import {
  IllegalSpecState,
  applyJsonPatchesRaw,
  type JsonPatch,
} from '../specPatcher.js';
import type { BuilderTool } from './types.js';

/**
 * `set_quality_config` — Phase-1 Kemia builder tool.
 *
 * Writes the response-quality settings (sycophancy level + boundary
 * presets / custom lines) into `spec.quality` of the active draft.
 * The persisted shape is consumed by the `responseGuard@1` provider
 * plugin at runtime via the AGENT.md frontmatter parser (Phase 2.1+);
 * before the parser lands, this tool still surfaces in the Builder so
 * codegen can carry the field forward and the install pipeline picks
 * it up verbatim.
 *
 * Distinct from `patch_spec` because the input is a structured object
 * rather than a JSON-patch list — this avoids the LLM having to
 * reinvent the right pointer path on every call.
 */

// Tool-side input schema — same SHAPE as `QualityConfigSchema` in
// agentSpec.ts but without `.default([])` on the inner arrays. The
// BuilderTool surface constrains `input: z.ZodType<I>` with a single
// type parameter, which conflicts with ZodDefault's diverging
// input/output types. Using `.optional()` here keeps the type inference
// trivial while preserving the same admission rules at runtime: unset
// fields fall through to "no preset list / no custom list".
const InputSchema = z
  .object({
    sycophancy: SycophancyLevelSpecSchema.optional(),
    boundaries: z
      .object({
        presets: z.array(z.string().min(1)).optional(),
        custom: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface OkResult {
  ok: true;
  applied: JsonPatch[];
  /** Echo of the persisted block — useful for the BuilderAgent's
   *  follow-up reasoning ("OK, sycophancy is now medium"). */
  quality: Input;
}

interface ErrResult {
  ok: false;
  error: string;
}

type Result = OkResult | ErrResult;

export const setQualityConfigTool: BuilderTool<Input, Result> = {
  id: 'set_quality_config',
  description:
    'Set the response-quality block on the draft AgentSpec (sycophancy + boundary presets / custom lines). ' +
    'Sycophancy levels: off (no anti-flattery rules), low (mild correction), medium (balanced), high (devil\'s-advocate). ' +
    'Boundary presets are picked from a closed library — unknown ids are dropped at runtime. ' +
    'This tool replaces any existing `spec.quality` block in full; pass an empty `{}` to clear it.',
  input: InputSchema,
  async run(input, ctx) {
    const draft = await ctx.draftStore.load(ctx.userEmail, ctx.draftId);
    if (!draft) {
      return { ok: false, error: `draft ${ctx.draftId} not found for user` };
    }

    // The patch path is `/quality`. `add` semantics on a plain object
    // either create or replace the key — see specPatcher.applyObject.
    const patches: JsonPatch[] = [
      { op: 'add', path: '/quality', value: input },
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
      quality: input,
    };
  },
};
