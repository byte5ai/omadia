import { z } from 'zod';

import type { BuildStatusSnapshot } from '../buildPipeline.js';
import type { BuilderTool } from './types.js';

/**
 * Issue #227 — `get_build_status`.
 *
 * Pull the last codegen→staging→tsc→zip build outcome for the current draft.
 * Lets the Builder agent verify a manifest-synthesis / tsc fix landed after a
 * platform update without asking the operator to drive a preview round-trip
 * and report back verbally. The status is retained by `BuildPipeline` — the
 * single chokepoint every preview / install build flows through — so it
 * stays in lock-step with the `build_status` SSE events the UI sees.
 */

const InputSchema = z.object({}).strict();

type Input = z.infer<typeof InputSchema>;

interface KnownResult extends BuildStatusSnapshot {
  ok: true;
}
interface UnknownResult {
  ok: true;
  status: 'unknown';
  note: string;
}
interface UnavailableResult {
  ok: false;
  error: string;
}
type Result = KnownResult | UnknownResult | UnavailableResult;

export const getBuildStatusTool: BuilderTool<Input, Result> = {
  id: 'get_build_status',
  description:
    'Return the last build outcome for the current draft: status (ok | ' +
    'failed), the failure phase when failed (codegen | staging | tsc | …), ' +
    'tsc error count, and a timestamp. Use it to confirm a codegen / tsc fix ' +
    'took effect after a platform update — no operator preview round-trip ' +
    'needed. Reports "unknown" when no build has run yet this process. ' +
    'Read-only.',
  input: InputSchema,
  async run(_input, ctx) {
    if (!ctx.lastBuildStatus) {
      return {
        ok: false,
        error:
          'build-status surface is not wired in this environment — no build ' +
          'pipeline available to query',
      };
    }
    const snapshot = ctx.lastBuildStatus(ctx.draftId);
    if (!snapshot) {
      return {
        ok: true,
        status: 'unknown',
        note:
          'No build has run for this draft in the current platform process. ' +
          'Patch the spec or trigger a preview build, then check again.',
      };
    }
    return { ok: true, ...snapshot };
  },
};
