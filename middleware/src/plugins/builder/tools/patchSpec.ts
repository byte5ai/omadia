import { z } from 'zod';

import { safeParseAgentSpec } from '../agentSpec.js';
import {
  checkSpecDelta,
  formatViolations as formatContentGuardViolations,
  type ContentGuardViolation,
} from '../contentGuard.js';
import {
  validateSpec,
  formatViolations as formatLintViolations,
  type ManifestViolation,
} from '../manifestLinter.js';
import type { AgentSpecSkeleton } from '../types.js';
import {
  IllegalSpecState,
  JsonPatchSchema,
  applyJsonPatchesRaw,
  type JsonPatch,
} from '../specPatcher.js';
import type { BuilderTool } from './types.js';

const InputSchema = z
  .object({
    patches: z
      .array(JsonPatchSchema)
      .min(1, 'patches must contain at least one operation'),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface OkResult {
  ok: true;
  applied: JsonPatch[];
}
interface ErrResult {
  ok: false;
  error: string;
  /** Present when the rejection comes from B.7-3 Content-Guard. */
  contentGuardViolations?: ContentGuardViolation[];
  /** Present when the rejection comes from B.8 Manifest-Linter. */
  manifestViolations?: ManifestViolation[];
}
type Result = OkResult | ErrResult;

export const patchSpecTool: BuilderTool<Input, Result> = {
  id: 'patch_spec',
  description:
    'Apply RFC-6902-subset patches (add | replace | remove) to the draft AgentSpec. ' +
    'Use this for every field mutation — id, name, tools, depends_on, slots, etc. ' +
    'Operate incrementally: small batches per turn beat one giant final patch. ' +
    'JSON-Pointer paths use leading slash, e.g. "/name" or "/tools/-" (array append).',
  input: InputSchema,
  async run({ patches }, ctx) {
    const draft = await ctx.draftStore.load(ctx.userEmail, ctx.draftId);
    if (!draft) {
      return { ok: false, error: `draft ${ctx.draftId} not found for user` };
    }

    let nextSpec: AgentSpecSkeleton;
    try {
      nextSpec = applyJsonPatchesRaw(draft.spec, patches) as AgentSpecSkeleton;
    } catch (err) {
      const message = err instanceof IllegalSpecState ? err.message : String(err);
      return { ok: false, error: message };
    }

    // B.6-10: strict-mode regression check. The historical issue (review-4)
    // was the agent inserting an Object into `network.outbound` (which Zod
    // declares as `string[]`). The raw patch path applied happily; the bug
    // surfaced two turns later in codegen. Now: if the PRE-patch spec was
    // already Zod-valid AND the POST-patch spec is no longer valid, we
    // refuse the save and surface the validation error to the agent so the
    // next iteration can correct the patch shape. Mid-construction drafts
    // (pre-patch already invalid because half the required fields are
    // missing) keep the existing best-effort behaviour — we don't want to
    // block the agent from filling in `id`/`name` one field at a time just
    // because the empty default isn't valid yet.
    const preWasValid = safeParseAgentSpec(draft.spec).success;
    if (preWasValid) {
      const postCheck = safeParseAgentSpec(nextSpec);
      if (!postCheck.success) {
        return {
          ok: false,
          error:
            'patch_spec strict-mode rejected: the patch would break the ' +
            'AgentSpec contract that the previous version satisfied. ' +
            'Fix the patch shape and re-issue. Zod errors: ' +
            formatZodErrors(postCheck.error.issues),
        };
      }
    }

    // B.7-3: Content-Guard — reject silent capability loss. Set-shrink on
    // tools/capabilities/depends_on/network.outbound is only allowed if the
    // user's chat message names the removed entry (case-insensitive).
    const guard = checkSpecDelta(draft.spec, nextSpec, {
      userIntent: ctx.userMessage,
    });
    if (!guard.ok) {
      return {
        ok: false,
        error:
          'patch_spec rejected by content-guard:\n' +
          formatContentGuardViolations(guard.violations),
        contentGuardViolations: guard.violations,
      };
    }

    // B.8-2: Manifest-Linter — cross-ref + structural checks (depends_on
    // resolvable, tool-id unique/syntax, network.outbound hosts, reserved
    // ids). Hard gate, no override path. Spec is NOT persisted on
    // failure — unlike Content-Guard this is structural correctness, not
    // a semantic intent check.
    const lint = validateSpec(nextSpec, {
      knownPluginIds: ctx.knownPluginIds,
    });
    if (!lint.ok) {
      return {
        ok: false,
        error:
          'patch_spec rejected by manifest-linter:\n' +
          formatLintViolations(lint.violations),
        manifestViolations: lint.violations,
      };
    }

    await ctx.draftStore.update(ctx.userEmail, ctx.draftId, { spec: nextSpec });
    ctx.bus.emit(ctx.draftId, {
      type: 'spec_patch',
      patches: [...patches],
      cause: 'agent',
    });
    ctx.rebuildScheduler.schedule(ctx.userEmail, ctx.draftId);

    return { ok: true, applied: [...patches] };
  },
};

function formatZodErrors(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.length > 0 ? `/${i.path.join('/')}` : '/'}: ${i.message}`)
    .join('; ');
}
