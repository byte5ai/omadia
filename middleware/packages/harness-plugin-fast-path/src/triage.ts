import { defaultSummary, parseSummary, supportedLocale, type FastPathToolSpec } from './fastPath.js';
import { extractFirstJsonObject } from './jsonExtract.js';
import { planToFetch, type LearnedPlan } from './learnedPlanStore.js';
import { containsPlaceholder } from './literalStripping.js';
import { parseRefreshSource, type RefreshSource } from './refreshRecipes.js';

/**
 * Chat-channel triage — ONE fast-model call per non-canvas turn decides
 * "deterministic vs agent". A deterministic decision carries the ONE read
 * query that answers the message (a refresh recipe, the same contract the
 * canvas composer plans), column labels and a prose template; an agent
 * decision carries the simple/complex route the per-turn model router would
 * otherwise classify with a call of its own.
 *
 * The planner only sees the user's (masked) text, the previous fast-path
 * query of the conversation, literal-stripped learned plans and the tool
 * specs — never a row. Anything off in its answer is a reasoned miss.
 */

export type TriageRoute = 'simple' | 'complex';

export type TriageDecision =
  | {
      decision: 'deterministic';
      fetch: RefreshSource;
      /** fieldKey → column header in the user's language */
      labels: Record<string, string>;
      summary: string;
      locale?: string;
      /** the planner's summary was missing/unusable — `summary` is the
       *  deterministic count sentence (logged, never a miss) */
      summaryDefaulted?: true;
    }
  | { decision: 'agent'; route?: TriageRoute }
  | { decision: 'invalid'; reason: string };

/** The previous fast-path answer of this conversation (follow-ups). */
export interface PreviousQuery {
  question: string;
  fetch: RefreshSource;
}

/** Max columns a deterministic chat answer may show. */
export const MAX_COLUMNS = 8;

export const TRIAGE_SYSTEM = `You are the Omadia fast-path triage. For ONE user chat message decide whether it is answered by exactly ONE read query with one of the TOOLS below (plus at most a simple equality/date-part post-filter) — the rows are then shown to the user as a table under a templated sentence — or whether the full agent must answer.
Emit ONLY a raw JSON object, either
{"decision":"deterministic","fetch":{"tool","input":<the EXACT tool input>,"map":{<fieldKey>:<record attribute>},"rowKey"?:<attribute with a stable id>,"itemsPath"?:<dot-path to the record array>,"filter"?:[{"field","datePart":"year"|"month"|"day","eq":<integer>}|{"field","eq":<string|number|boolean>}]},"labels":{<fieldKey>:<column header in the user's language>},"summary":<ONE plain sentence in the user's language with {count} (= number of rows) and/or {sum:<fieldKey>} (= total of a NUMERIC column)>,"locale":<BCP-47 of the user's language, e.g. "de-DE">}
or {"decision":"agent","route":"simple"|"complex"}.
RULES:
- deterministic ONLY for a plain lookup/list whose answer IS the rows ("Geburtstage im Januar", "offene Posten von Müller", "wie viele Kunden in Berlin"). Explanations, advice, opinions, writes or changes, several queries, joins, comparisons, aggregation beyond {count}/{sum:…}, smalltalk, anything you are unsure about (tool, fields, values) → agent. A wrong fetch is worse than none.
- A follow-up ("und im Februar?", "and for Weber?") may adapt the PREVIOUS QUERY: keep tool, input structure and map, change only values. Prefer adapting a VALIDATED EXAMPLE when one has the same intent; replace every {{text_N}}/{{email_N}}/{{id_N}} placeholder with the user's own value — a fetch that still contains one is discarded.
- "map": short snake_case fieldKeys, at most ${MAX_COLUMNS}, every fieldKey also in "labels"; a map value may be a dot-path into the record (e.g. "partner_id.1").
- Relative periods: a whole-string "{today}" / "{today-30d}" / "{today+7d}" — never the current date literally. A {sum:…} over money needs "currency_id" in the query's fields.
- "summary" and "locale" are REQUIRED with every deterministic decision. The summary MUST contain {count} or {sum:<fieldKey>} (e.g. "{count} Mitarbeitende haben im Januar Geburtstag.") and states ONLY what the query guarantees; never invent figures.
- route (agent only): "simple" = greeting, chit-chat, a single factual lookup, a short confirmation, a one-step request; "complex" = multi-step, agentic, tool-heavy, code, analysis, planning, or when unsure.
Output ONLY the JSON object — no code fences, no prose before or after it.`;

/** The triage user prompt: tools, learned examples, previous query, message. */
export function buildTriagePrompt(opts: {
  question: string;
  tools: readonly FastPathToolSpec[];
  examples: readonly LearnedPlan[];
  previous?: PreviousQuery;
}): string {
  const lines = [`TOOLS:\n${opts.tools.map((t) => `- ${t.spec}`).join('\n')}`];
  if (opts.examples.length > 0) {
    lines.push(
      `VALIDATED EXAMPLES (learned from verified answers in this workspace):\n${opts.examples
        .map((p) => `- user asked "${p.examples[0] ?? ''}" → "fetch": ${JSON.stringify(planToFetch(p))}`)
        .join('\n')}`,
    );
  }
  if (opts.previous) {
    lines.push(
      `PREVIOUS QUERY OF THIS CONVERSATION: user asked "${opts.previous.question}" → "fetch": ${JSON.stringify(opts.previous.fetch)}`,
    );
  }
  lines.push(`USER MESSAGE: ${opts.question}`);
  return lines.join('\n');
}

/** Validate the triage answer against the whitelist; anything off is
 *  `invalid` with a reason, never a partial plan. A missing or unusable
 *  summary is not "off": the plan keeps a deterministic count sentence in
 *  the planner's locale (else a guess from `opts.question`). */
export function parseTriage(
  raw: string,
  allowedTools: ReadonlySet<string>,
  opts: { question?: string } = {},
): TriageDecision {
  const extracted = extractFirstJsonObject(raw);
  if (!extracted.ok) return { decision: 'invalid', reason: 'unparseable' };
  const o = extracted.value;
  if (o['decision'] === 'agent') {
    const route = o['route'] === 'simple' || o['route'] === 'complex' ? o['route'] : undefined;
    return route ? { decision: 'agent', route } : { decision: 'agent' };
  }
  if (o['decision'] !== 'deterministic') return { decision: 'invalid', reason: 'unknown-decision' };
  const fetch = parseRefreshSource(o['fetch']);
  if (!fetch) return { decision: 'invalid', reason: 'invalid-fetch' };
  if (!allowedTools.has(fetch.tool)) return { decision: 'invalid', reason: 'tool-not-allowed' };
  if (containsPlaceholder(fetch)) return { decision: 'invalid', reason: 'unfilled-placeholder' };
  const keys = Object.keys(fetch.map);
  if (keys.length > MAX_COLUMNS) return { decision: 'invalid', reason: 'too-many-columns' };
  const locale = supportedLocale(o['locale']);
  const parsedSummary = parseSummary(o['summary']);
  const summary = parsedSummary ?? defaultSummary(locale, opts.question);
  const rawLabels =
    typeof o['labels'] === 'object' && o['labels'] !== null ? (o['labels'] as Record<string, unknown>) : {};
  const labels: Record<string, string> = {};
  for (const k of keys) {
    const l = rawLabels[k];
    labels[k] = typeof l === 'string' && l.trim().length > 0 ? l.trim().slice(0, 60) : k;
  }
  return {
    decision: 'deterministic',
    fetch,
    labels,
    summary,
    ...(locale ? { locale } : {}),
    ...(parsedSummary === undefined ? { summaryDefaulted: true as const } : {}),
  };
}
