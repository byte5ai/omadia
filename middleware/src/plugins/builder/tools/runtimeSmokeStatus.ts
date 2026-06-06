import { z } from 'zod';

import type { SmokeStatusSnapshot } from '../runtimeSmokeOrchestrator.js';
import type { BuilderTool } from './types.js';

/**
 * Issue #227 — `runtime_smoke_status`.
 *
 * Pull the last runtime-smoke outcome for the current draft: whether the
 * plugin activated, which tools/admin-routes/ui-routes were exercised and how
 * they fared. The smoke pass already runs after every preview build (it is
 * how `ctx.memory unavailable`-class activation gaps are detected) but its
 * result only flowed to the SSE stream — invisible to the Builder agent. This
 * tool exposes the retained result so the agent can self-diagnose
 * activate-time failures before the operator restarts the preview.
 */

const InputSchema = z.object({}).strict();

type Input = z.infer<typeof InputSchema>;

interface KnownResult extends SmokeStatusSnapshot {
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

export const runtimeSmokeStatusTool: BuilderTool<Input, Result> = {
  id: 'runtime_smoke_status',
  description:
    'Return the last runtime-smoke result for the current draft: did the ' +
    'plugin activate, and how did its tools / admin-routes / ui-routes fare ' +
    'when invoked with synthetic input. Use it to confirm activate-time ' +
    'availability (e.g. ctx.memory / ctx.http) after a platform update ' +
    'without an operator preview round-trip. Reports "unknown" when no smoke ' +
    'has run yet this process; "running" while one is in flight. Read-only.',
  input: InputSchema,
  async run(_input, ctx) {
    if (!ctx.lastSmokeStatus) {
      return {
        ok: false,
        error:
          'runtime-smoke surface is not wired in this environment — no smoke ' +
          'orchestrator available to query',
      };
    }
    const snapshot = ctx.lastSmokeStatus(ctx.draftId);
    if (!snapshot) {
      return {
        ok: true,
        status: 'unknown',
        note:
          'No runtime-smoke has run for this draft in the current platform ' +
          'process. It fires automatically after the next successful preview ' +
          'build — trigger one and check again.',
      };
    }
    return { ok: true, ...snapshot };
  },
};
