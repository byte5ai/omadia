import { z } from 'zod';

import {
  safeParseAgentSpec,
  validateSpecForCodegen,
  type AgentSpec,
  type SpecValidationIssue,
} from '../agentSpec.js';
import type { BuilderTool } from './types.js';

const InputSchema = z.object({}).strict();

type Input = z.infer<typeof InputSchema>;

export type LintSeverity = 'error' | 'warning';

export interface LintIssue {
  severity: LintSeverity;
  code: string;
  message: string;
  path?: string;
}

interface Result {
  ok: boolean;
  issues: LintIssue[];
}

export const lintSpecTool: BuilderTool<Input, Result> = {
  id: 'lint_spec',
  description:
    'Run deterministic checks against the current draft AgentSpec. Reports ' +
    'errors that prevent codegen (Zod-fail, reserved-tool collision, missing ' +
    'required fields) and warnings that are correctness smells (loose semver, ' +
    'name-collision with installed agents, suspicious slot content). Call ' +
    'before declaring the agent ready.',
  input: InputSchema,
  async run(_input, ctx) {
    const draft = await ctx.draftStore.load(ctx.userEmail, ctx.draftId);
    if (!draft) {
      return {
        ok: false,
        issues: [
          {
            severity: 'error',
            code: 'draft_not_found',
            message: `draft ${ctx.draftId} not found for user`,
          },
        ],
      };
    }

    const issues: LintIssue[] = [];

    // 1. Zod validation
    const parsed = safeParseAgentSpec(draft.spec);
    if (!parsed.success) {
      for (const zerr of parsed.error.issues) {
        issues.push({
          severity: 'error',
          code: `zod.${zerr.code}`,
          message: zerr.message,
          path: '/' + zerr.path.map(String).join('/'),
        });
      }
      // Without a parsed spec we can't run the cross-field checks below, but
      // we DO still run the slot/depends_on/name checks against the raw skeleton.
      issues.push(...lintSlots(draft.slots));
      issues.push(...lintNameCollision(draft.spec.name, ctx.catalogToolNames()));
      return { ok: false, issues };
    }

    const spec: AgentSpec = parsed.data;

    // 2. Cross-field checks already implemented in agentSpec.ts. Pass
    //    `draft.slots` as additionalSlots so the validator sees fillSlot-
    //    written entries that live on `draft.slots` but not on
    //    `draft.spec.slots` — same Catch-22 fix as in codegen.ts:646.
    //    Without this, lint_spec keeps firing react-ssr/free-form-html
    //    missing-slot errors even after fill_slot succeeded (the slot is
    //    persisted, just not visible via spec.slots).
    const codegenIssues: SpecValidationIssue[] = validateSpecForCodegen(
      spec,
      draft.slots,
    );
    for (const ci of codegenIssues) {
      issues.push({
        severity: 'error',
        code: ci.code,
        message: ci.reason,
        path: ci.toolId ? `/tools[id=${ci.toolId}]` : undefined,
      });
    }

    // 3. Catalog-name collision (warning, since it might be intentional)
    issues.push(...lintNameCollision(spec.name, ctx.catalogToolNames()));

    // 4. Slot quality
    issues.push(...lintSlots(draft.slots));

    // 5. ctx.<accessor> ↔ permission consistency. Catches the
    //    "slot uses a gated accessor but the spec never granted it" class of
    //    bug at lint time instead of as a runtime `undefined` crash inside a
    //    tool handler. Needs the parsed spec (permissions/network), so it
    //    only runs on the success path.
    issues.push(...lintAccessorPermissions(spec, draft.slots));

    return { ok: issues.every((i) => i.severity !== 'error'), issues };
  },
};

function lintNameCollision(
  name: string,
  catalogNames: readonly string[],
): LintIssue[] {
  if (!name) return [];
  // Case-insensitive substring match against any registered catalog tool —
  // a fuzzy collision warning, not a hard block.
  const needle = name.toLowerCase();
  for (const cat of catalogNames) {
    if (cat.toLowerCase() === needle) {
      return [
        {
          severity: 'warning',
          code: 'name_collision',
          message: `agent name '${name}' collides with catalog tool '${cat}'`,
          path: '/name',
        },
      ];
    }
  }
  return [];
}

/**
 * One gated `ctx.*` accessor and the spec declaration that turns it on.
 *
 * `ctx.memory` is deliberately absent: unlike the accessors below it is a
 * PLATFORM DEFAULT, not spec-gated. The boilerplate `manifest.yaml` always
 * ships `permissions.memory.{reads,writes}` with `agent:<id>:*`, the spec
 * schema (`PermissionsSchema`) can't even express memory permissions, and
 * codegen never strips the block — so `ctx.memory` is always available and a
 * reference to it can never be a misconfiguration. (The historical
 * "ctx.memory unavailable" crash was a *preview-runtime* gap, since fixed in
 * previewRuntime.ts — never a missing manifest permission.) Flagging
 * `ctx.memory` here would only produce false positives on every memory-using
 * agent, so it is omitted by design.
 */
interface GatedAccessor {
  /** Accessor property on `ctx`, e.g. 'subAgent'. */
  readonly accessor: string;
  /** Human-readable spec field the operator must set to grant it. */
  readonly specField: string;
  /** Returns true when the spec grants the accessor (non-empty declaration). */
  readonly granted: (spec: AgentSpec) => boolean;
}

const GATED_ACCESSORS: readonly GatedAccessor[] = [
  {
    accessor: 'subAgent',
    specField: 'permissions.subAgents.calls',
    granted: (s) => (s.permissions?.subAgents?.calls?.length ?? 0) > 0,
  },
  {
    accessor: 'llm',
    specField: 'permissions.llm.models_allowed',
    granted: (s) => (s.permissions?.llm?.models_allowed?.length ?? 0) > 0,
  },
  {
    accessor: 'knowledgeGraph',
    specField: 'permissions.graph.entity_systems',
    granted: (s) => (s.permissions?.graph?.entity_systems?.length ?? 0) > 0,
  },
  {
    accessor: 'http',
    specField: 'network.outbound',
    granted: (s) => (s.network?.outbound?.length ?? 0) > 0,
  },
];

/**
 * Warn when a slot actually *uses* a gated accessor (`ctx.<accessor>.foo`,
 * `ctx.<accessor>!.foo`, or `ctx.<accessor>?.foo`) but the spec never granted
 * the matching permission — at runtime that accessor is `undefined`, so the
 * handler throws (or, with optional chaining, silently no-ops). A bare
 * boolean guard like `if (ctx.subAgent)` is intentionally NOT matched: the
 * trailing-dot requirement keeps the check to real usage and lets defensive
 * guards pass.
 *
 * Severity is `warning`, consistent with the other correctness smells here:
 * the spec still builds, and an over-eager match (e.g. an accessor named in a
 * comment) should not hard-block codegen.
 */
function lintAccessorPermissions(
  spec: AgentSpec,
  slots: Record<string, string | undefined>,
): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const { accessor, specField, granted } of GATED_ACCESSORS) {
    if (granted(spec)) continue;
    // ctx.<accessor> followed by `.`, `!.`, or `?.` then a member name.
    const usage = new RegExp(`\\bctx\\.${accessor}\\s*[!?]?\\s*\\.\\s*\\w`);
    for (const [key, source] of Object.entries(slots)) {
      if (typeof source !== 'string' || !usage.test(source)) continue;
      issues.push({
        severity: 'warning',
        code: 'accessor_permission_undeclared',
        message:
          `slot '${key}' uses ctx.${accessor} but the spec does not grant it — ` +
          `set ${specField} (the accessor is undefined at runtime otherwise)`,
        path: `/slots/${key}`,
      });
    }
  }
  return issues;
}

function lintSlots(slots: Record<string, string | undefined>): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const [key, source] of Object.entries(slots)) {
    if (typeof source !== 'string') continue;
    // The boilerplate construct assumes `systemPrompt` is read from the
    // skill markdown via FilesystemSkillsLoader, NOT inlined as a string
    // literal in `activate()`. A string-literal `systemPrompt:` in slot
    // source is a strong signal the LLM mis-read the contract.
    if (/(\s|^)systemPrompt\s*:\s*['"`]/.test(source)) {
      issues.push({
        severity: 'warning',
        code: 'inline_system_prompt',
        message: `slot '${key}' contains an inline systemPrompt literal — read from skill markdown instead`,
        path: `/slots/${key}`,
      });
    }
    if (source.trim().length === 0) {
      issues.push({
        severity: 'error',
        code: 'empty_slot',
        message: `slot '${key}' is empty — remove it or fill it`,
        path: `/slots/${key}`,
      });
    }
  }
  return issues;
}
