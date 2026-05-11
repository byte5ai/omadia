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
      for (const zerr of parsed.error.errors) {
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

    // 2. Cross-field checks already implemented in agentSpec.ts
    const codegenIssues: SpecValidationIssue[] = validateSpecForCodegen(spec);
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
