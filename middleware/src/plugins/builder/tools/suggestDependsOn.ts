import { z } from 'zod';

import type { BuilderTool } from './types.js';

const InputSchema = z
  .object({
    intent: z
      .string()
      .min(1, 'intent must be non-empty')
      .max(500, 'intent too long'),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface Result {
  ok: true;
  intent: string;
  suggestions: Array<{ agentId: string; reason: string }>;
}

interface KeywordRule {
  readonly keywords: readonly RegExp[];
  readonly agentId: string;
  readonly reason: string;
}

const RULES: readonly KeywordRule[] = [
  {
    keywords: [/\bodoo\b/i, /\baccounting\b/i, /\bbuchhalt/i, /\binvoice/i, /\brechnung/i],
    agentId: 'de.byte5.integration.odoo',
    reason: 'intent mentions Odoo / accounting / invoicing',
  },
  {
    keywords: [/\bconfluence\b/i, /\bplaybook\b/i, /\bwiki\b/i],
    agentId: 'de.byte5.integration.confluence',
    reason: 'intent mentions Confluence / playbooks / wiki',
  },
  {
    keywords: [
      /\boutlook\b/i,
      /\bm365\b/i,
      /\bmicrosoft\s*365\b/i,
      /\bteams\b/i,
      /\bemail/i,
      /\bcalendar\b/i,
      /\bkalender\b/i,
    ],
    agentId: 'de.byte5.integration.microsoft365',
    reason: 'intent mentions Microsoft 365 / Outlook / Teams / calendar / email',
  },
  {
    keywords: [/\bsearch the web\b/i, /\bsearch web\b/i, /\bweb search/i, /\bgoogle/i],
    agentId: '@omadia/plugin-web-search',
    reason: 'intent mentions web search',
  },
  {
    keywords: [/\bseo\b/i, /\bsearch engine\b/i, /\branking/i, /\bpagespeed/i],
    agentId: '@omadia/agent-seo-analyst',
    reason: 'intent mentions SEO / search-engine / ranking',
  },
];

export const suggestDependsOnTool: BuilderTool<Input, Result> = {
  id: 'suggest_depends_on',
  description:
    'Heuristic: given a free-form intent string ("invoice automation in Odoo", ' +
    '"summarise Confluence playbooks"), return likely depends_on agent IDs from ' +
    'the platform catalog. Suggestions are advisory — the BuilderAgent still ' +
    'decides which to keep, and lint_spec validates the final list.',
  input: InputSchema,
  async run({ intent }, _ctx) {
    const seen = new Set<string>();
    const suggestions: Result['suggestions'] = [];
    for (const rule of RULES) {
      if (rule.keywords.some((re) => re.test(intent))) {
        if (seen.has(rule.agentId)) continue;
        seen.add(rule.agentId);
        suggestions.push({ agentId: rule.agentId, reason: rule.reason });
      }
    }
    return { ok: true, intent, suggestions };
  },
};
