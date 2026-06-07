/**
 * Plugin self-extension — the ExtensionProposal contract.
 *
 * A proposal is DECLARATIVE: it never carries generated code. It carries the
 * delta the agent wants applied to the plugin's own {@link AgentSpec},
 * expressed as the same RFC-6902-subset JSON patches the Builder already uses
 * ({@link ../builder/specPatcher.ts}). A new tool is `{op:'add',
 * path:'/tools/-', value:{id,description,input}}`; a new slot fill is an `add`
 * under `/slots`. Because the proposal is just patches against the live spec,
 * the escalation guard can apply it, derive the resulting privilege surface,
 * and prove `proposed ⊆ current` BEFORE any codegen runs.
 *
 * The optional {@link LimitSignal} ties the proposal back to the runtime wall
 * that motivated it (Layer A) — useful for the operator review and the audit
 * trail, not load-bearing for the guard.
 */

import { z } from 'zod';

import { JsonPatchSchema, type JsonPatch } from '../builder/specPatcher.js';

/** Mirrors `@omadia/plugin-api` `LimitSignal` for proposal validation without
 *  importing the runtime value (plugin-api ships types only here). */
const LimitSignalSchema = z
  .object({
    kind: z.enum([
      'row_cap',
      'page_truncated',
      'unsupported_operation',
      'rate_limited',
      'missing_capability',
    ]),
    detail: z.string().min(1),
    cap: z.number().optional(),
    observed: z.number().optional(),
    hint: z.string().optional(),
  })
  .strict();

export const ExtensionProposalSchema = z
  .object({
    /** The plugin proposing to extend itself. Must equal the live spec id;
     *  the guard rejects any patch that mutates `/id` (no impersonation). */
    pluginId: z.string().min(1),
    /** Why the extension is needed — shown to the operator, stored in audit. */
    rationale: z.string().min(1),
    /** The spec delta. At least one patch; capped to keep a looping agent from
     *  submitting a megabyte of ops. */
    patches: z.array(JsonPatchSchema).min(1).max(100),
    /** Optional pointer to the runtime limit that motivated the proposal. */
    limitSignal: LimitSignalSchema.optional(),
  })
  .strict();

export type ExtensionProposal = z.infer<typeof ExtensionProposalSchema>;

/** Parse + validate raw input into an {@link ExtensionProposal}. Throws a
 *  Zod error on malformed input. */
export function parseExtensionProposal(input: unknown): ExtensionProposal {
  return ExtensionProposalSchema.parse(input);
}

/** Re-export for callers building proposals programmatically. */
export type { JsonPatch };
