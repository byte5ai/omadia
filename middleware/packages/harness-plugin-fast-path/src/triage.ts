import { defaultSummary, parseSummary, summaryLanguage, supportedLocale } from './fastPath.js';
import { catalogColumnLabel } from './fieldLabels.js';
import { containsPlaceholder } from './literalStripping.js';
import { parseRefreshSource, type RefreshSource } from './refreshRecipes.js';

/**
 * Fast-path triage — the shared vocabulary and the plan whitelist.
 *
 * Every channel triages a turn in two forced-tool calls (router.ts →
 * planner.ts): the router decides deterministic vs agent (and simple vs
 * complex for the agent's model router), the planner writes the ONE read
 * query. This module validates the planner's query against the whitelist;
 * anything off is a reasoned miss, never a partial plan. The planner only
 * ever sees the user's (masked) text, the previous fast-path query, learned
 * plans and the tool spec — never a row.
 */

/** The agent route the per-turn model router takes instead of classifying. */
export type TriageRoute = 'simple' | 'complex';

/** The previous fast-path answer of this conversation (follow-ups). */
export interface PreviousQuery {
  question: string;
  fetch: RefreshSource;
}

/** Max columns a deterministic chat answer may show. */
export const MAX_COLUMNS = 8;

/** A validated deterministic plan: the query plus how to present it. */
export interface PlannedQuery {
  fetch: RefreshSource;
  /** fieldKey → column header in the user's language */
  labels: Record<string, string>;
  summary: string;
  locale?: string;
  /** the planner's summary was missing/unusable — `summary` is the
   *  deterministic count sentence (logged, never a miss) */
  summaryDefaulted?: true;
}

export type PlanValidation = { ok: true; plan: PlannedQuery } | { ok: false; reason: string };

/**
 * Validate a planned query `{fetch, labels|columns, summary, locale}` against
 * the whitelist. A missing or unusable summary is not "off": the plan keeps a
 * deterministic count sentence in the planner's locale (else a guess from
 * `opts.question`).
 */
export function validatePlannedQuery(
  o: Record<string, unknown>,
  allowedTools: ReadonlySet<string>,
  opts: { question?: string } = {},
): PlanValidation {
  const fetch = parseRefreshSource(o['fetch']);
  if (!fetch) return { ok: false, reason: 'invalid-fetch' };
  if (!allowedTools.has(fetch.tool)) return { ok: false, reason: 'tool-not-allowed' };
  if (containsPlaceholder(fetch)) return { ok: false, reason: 'unfilled-placeholder' };
  const keys = Object.keys(fetch.map);
  if (keys.length > MAX_COLUMNS) return { ok: false, reason: 'too-many-columns' };
  const locale = supportedLocale(o['locale']);
  const parsedSummary = parseSummary(o['summary']);
  const summary = parsedSummary ?? defaultSummary(locale, opts.question);
  const rawLabels = plannedLabels(o);
  const model =
    typeof fetch.input === 'object' && fetch.input !== null ? (fetch.input as Record<string, unknown>)['model'] : undefined;
  const lang = summaryLanguage(locale, opts.question);
  const labels: Record<string, string> = {};
  for (const k of keys) {
    const l = rawLabels[k];
    labels[k] =
      typeof l === 'string' && l.trim().length > 0
        ? l.trim().slice(0, 60)
        : catalogColumnLabel({ fieldKey: k, attr: fetch.map[k], model: typeof model === 'string' ? model : undefined, lang });
  }
  return {
    ok: true,
    plan: {
      fetch,
      labels,
      summary,
      ...(locale ? { locale } : {}),
      ...(parsedSummary === undefined ? { summaryDefaulted: true as const } : {}),
    },
  };
}

/** The planner's column headers: `labels` ({fieldKey: header}) and/or
 *  `columns` ([{key, label}]); `labels` wins on a conflict. */
function plannedLabels(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(o['columns'])) {
    for (const c of o['columns'] as unknown[]) {
      if (typeof c !== 'object' || c === null) continue;
      const { key, label } = c as Record<string, unknown>;
      if (typeof key === 'string') out[key] = label;
    }
  }
  const labels = o['labels'];
  return typeof labels === 'object' && labels !== null && !Array.isArray(labels)
    ? { ...out, ...(labels as Record<string, unknown>) }
    : out;
}
