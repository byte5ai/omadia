import {
  containsPlaceholder,
  extractFirstJsonObject,
  FAST_MODEL_REASONING,
  type JsonOutputShape,
  parseRefreshSource,
  parseSummary,
  supportedLocale,
  type FastLlm,
  type FastPathToolSpec,
  type RefreshSource,
  type StoredTextPrivacyRun,
} from '@omadia/fast-path';
import { validateTree } from './treeValidator.js';

/**
 * Tier-2 skeleton composition (PR-9b-2): one fast-model call turns the user's
 * request into (a) a schema-valid skeleton tree the client renders immediately
 * and (b) the data requirements the delegated main turn must satisfy — so
 * Tier-3 sub-agents return payloads matching exactly the fields the skeleton
 * promised.
 */

/** Narrow LLM port — structurally satisfied by `ctx.llm` (LlmAccessor). */
export type CompositionLlm = FastLlm;

/**
 * The composer call gates the first paint of EVERY canvas turn, so it asks
 * for the lowest-latency reasoning: thinking off where the model accepts it
 * (Haiku 5.5 — on by default there) and low effort as the lever every
 * effort-capable model honours. Both are hints the provider ignores where
 * they do not apply. Composing a skeleton is pattern-following, not
 * reasoning — a measured 3.4–10 s on adaptive thinking.
 */
export const COMPOSER_REASONING = FAST_MODEL_REASONING;

/** What the skeleton promised the user — handed to the delegated main turn as
 *  the `[canvas-context]` block (the requirement-handoff contract). */
export interface DataRequirement {
  containerId: string;
  description: string;
  dataClass?: string;
  fields: Array<{ fieldKey: string; label: string; type?: string }>;
  /** Deterministic fast path: the ONE query (an allow-listed tool) that
   *  fills this container, plus its fieldKey map and post-filter. Present
   *  only when the composer planned it and it parsed as a valid recipe for
   *  an allowed tool. Never forwarded to the agent's [canvas-context]. */
  fetch?: RefreshSource;
}

export interface SkeletonResult {
  tree: unknown;
  dataRequirements: DataRequirement[];
  source: 'model' | 'fallback';
  /** fast-path prose template in the user's language; carries `{count}`
   *  and/or `{sum:<fieldKey>}`. */
  summary?: string;
  /** BCP-47 tag the composer declared for number formatting (`{sum:…}`). */
  locale?: string;
}

export type { FastPathToolSpec };


/** A learned plan handed to the composer as a validated example: a past
 *  question (literal-stripped) and the fetch that answered it. */
export interface LearnedExample {
  question: string;
  fetch: RefreshSource;
}

/** The validated-examples block: plans learned from answers the full agent
 *  gave in this workspace — the composer adapts them instead of inventing. */
function learnedExamplesSection(examples: readonly LearnedExample[]): string {
  if (examples.length === 0) return '';
  return `
VALIDATED EXAMPLES (learned from verified answers in this workspace — prefer adapting one when the request has the same intent): adapt values to the request (e.g. another month or year) and replace every {{text_N}}/{{email_N}}/{{id_N}} placeholder with the user's own value from the request — a fetch that still contains a placeholder is discarded. Keep the tool, the input structure and the map unchanged.
${examples.map((e) => `- user asked "${e.question}" → "fetch": ${JSON.stringify(e.fetch)}`).join('\n')}`;
}

/** The FAST PATH section appended to the composer prompt when at least one
 *  tool is allow-listed — absent otherwise, so the prompt is unchanged. */
function fastPathPromptSection(
  tools: readonly FastPathToolSpec[],
  examples: readonly LearnedExample[] = [],
): string {
  return `

FAST PATH (optional — same JSON object, two extra keys): when the request is answered by exactly ONE read query per data container with one of the tools below (plus at most a simple equality/date-part post-filter), add to that dataRequirements entry:
  "fetch": { "tool", "input": <the EXACT tool input>, "map": { fieldKey: <record attribute> }, "rowKey"?: <attribute with a stable id>, "itemsPath"?: <dot-path to the record array>, "filter"?: [ { "field": <attribute>, "datePart": "year"|"month"|"day", "eq": <integer> } | { "field": <attribute>, "eq": <string|number|boolean> } ] }
and a top-level "summary": ONE plain sentence in the user's language with placeholders computed from the rows of the FIRST dataRequirement after the filter — {count} (= number of rows) and/or {sum:<fieldKey>} (= total of that container's NUMERIC column, e.g. an open amount) — correct for any count including 0, e.g. "{count} Mitarbeitende haben im Januar Geburtstag." or "{count} offene Posten über insgesamt {sum:amount} €.". With {sum:…} also add a top-level "locale" (BCP-47 of the user's language, e.g. "de-DE", "en-US") — the number is formatted for it; put a currency only as plain text. A {sum:…} over money also needs the record's "currency_id" in the query's fields: the total renders only when every row has ONE currency (otherwise the full agent answers). The summary states ONLY what the query guarantees; never invent figures.
- "map" covers EVERY fieldKey of the container's columns. A map value may be a dot-path into the record (e.g. "department_id.1").
- "filter" is for what the tool cannot filter itself (e.g. a birthday MONTH); put everything else into the tool's own query.
- Express relative periods time-safely (a tool's relative-date syntax, e.g. "{today}" below) or omit fetch. OMIT fetch (and summary) whenever the request needs reasoning, joins, aggregation beyond {count}/{sum:…}, several steps, a tool not listed, or you are unsure of the field names — the full agent then handles it. A wrong fetch is worse than none.
TOOLS:
${tools.map((t) => `- ${t.spec}`).join('\n')}${learnedExamplesSection(examples)}`;
}

/** Whitelist the composer's `fetch` plans: kept only when it parses as a
 *  refresh recipe for an allowed tool; anything else is dropped (the
 *  requirement itself stays). */
function withFetchPlans(
  reqs: DataRequirement[],
  allowed: ReadonlySet<string>,
): DataRequirement[] {
  return reqs.map((r) => {
    const { fetch: raw, ...rest } = r as DataRequirement & { fetch?: unknown };
    if (raw === undefined || allowed.size === 0) return rest;
    const fetch = parseRefreshSource(raw);
    // an unfilled learned-plan placeholder would query for "{{text_1}}"
    return fetch && allowed.has(fetch.tool) && !containsPlaceholder(fetch)
      ? { ...rest, fetch }
      : rest;
  });
}

export { parseSummary };

export const FALLBACK_SKELETON = {
  type: 'container',
  id: 'root',
  layout: 'stack',
  children: [{ type: 'status', id: 'st', text: 'Working on it…', loading: 'spinner' }],
} as const;

const SYSTEM_PROMPT = `You are the Omadia UI Tier-2 composer. Given a user request, emit ONLY a JSON object:
{ "tree": <primitive tree>, "dataRequirements": [{ "containerId", "description", "dataClass"?, "fields": [{ "fieldKey", "label", "type"? }] }] }

The tree is a SKELETON for data still being fetched: data-carrying primitives set "loading":"skeleton" with EMPTY rows/items/points ([]). The fetched data is patched in later.

PRIMITIVE SHAPES — emit EXACTLY these keys, no others (extra keys are rejected). Every node MAY carry "id" (stable string) and "loading":"none"|"skeleton"|"spinner".
- container: { "type":"container", "id", "layout":"stack"|"split"|"grid"|"flow", "children":[ ...primitives ], "title"?:string }
- heading:   { "type":"heading", "content":string, "level"?:1..6 }
- text:      { "type":"text", "content":string }
- status:    { "type":"status", "text":string, "tone"?:"neutral"|"info"|"success"|"warning"|"danger" }
- divider:   { "type":"divider" }
- table:     { "type":"table", "id", "loading":"skeleton", "columns":[ { "fieldKey":string, "label":string, "type"?:string } ], "rows":[] }
- list:      { "type":"list", "id", "loading":"skeleton", "items":[] }
- chart:     { "type":"chart", "id", "loading":"skeleton", "chartType":"bar"|"line"|"pie", "points":[] }
- tabs:      { "type":"tabs", "id", "tabs":[ { "label":string, "child": <ONE primitive> } ] }
- pane:      { "type":"pane", "id", "title"?:string, "container"?: <ONE primitive>, "children"?:[ ...primitives ] }
- button:    { "type":"button", "id", "label":string, "action"?:{ "type":string, "payload"?:object } }
- choice:    { "type":"choice", "id", "label"?:string, "variant"?:"radio"|"dropdown", "options":[ { "value":string, "label":string } ] }
- input:     { "type":"input", "id", "label"?:string, "value"?:string, "placeholder"?:string }
- toggle:    { "type":"toggle", "id", "label"?:string, "value"?:boolean, "variant"?:"checkbox"|"switch" }
- form:      { "type":"form", "id", "title"?:string, "children":[ ...primitives ] }
- toolbar:   { "type":"toolbar", "id", "children":[ ...primitives ] }
- progress:  { "type":"progress", "id", "value"?:number, "indeterminate"?:boolean }
- image:     { "type":"image", "id", "src":string, "altText"?:string }
- tree:      { "type":"tree", "id", "nodes":[ { "itemKey":string, "label"?:string, "children"?:[ ...nodes ] } ] }

RULES:
- The ROOT must be a container.
- table REQUIRES columns AND rows (rows:[] when skeleton). list REQUIRES items:[]. chart REQUIRES chartType AND points:[].
- tabs REQUIRES tabs:[]; each tab is { "label", "child" } where child is ONE primitive (usually a container/table).
- A table row later looks like { "rowKey":string, "cells":{ fieldKey: value } } — you only emit the EMPTY skeleton, not rows.
- dataRequirements: one entry per data-carrying container, naming EXACTLY the fieldKeys its columns/fields use.
- INTERACTION: when the request implies picking between alternatives, render a choice (one option per alternative, stable values) — never plan a prose question. Editable parameters → input/toggle inside a form; primary commands → button with an action.
- CHART TYPE is YOUR decision (Tier 2): time series / development over time → "line"; comparing categories → "bar"; share-of-whole → "pie". Each chart needs a dataRequirements entry with fields label + value.
- SCALAR / KPI BLOCK (named single values like scores or metrics — NOT rows of a table): use a container with "loading":"skeleton" whose children are one small container per metric, each holding a "heading" (the label) and a VALUE node { "type":"text", "id":"<containerId>.<fieldKey>", "content":"" }. The value node id MUST be EXACTLY "<containerId>.<fieldKey>" — that id is how the fetched value is patched in. Add ONE dataRequirements entry for the block: { "containerId":"<id>", "fields":[ { "fieldKey", "label" }, … ] }. The main turn fills it with { containerId, fields:{ fieldKey: value } }, NOT rows. Use this for a header of scores/KPIs; use a table only for repeating records.
- SHOW STATE, DON'T NARRATE IT: render state as a glyph, not a sentence. Pass/fail/pending/synced → a "status" whose "text" NAMES the state (e.g. "Synced", "Failed") with the matching "tone" (success/danger/warning/info/neutral). Tone AUGMENTS the label — it never carries the meaning alone (colour-as-sole-signal fails colourblind + screen-reader users); always keep a text/glyph that states the value. Percent-complete → "progress". A trend or comparison across values → "chart". What to DROP is the extra narrating sentence next to a glyph that already shows it ("The sync completed successfully." beside a success chip) — keep the labelled glyph, cut the prose.
- A fetched data set may be EMPTY — the table keeps rows:[]; never plan placeholder rows.
- NO DATA VALUES IN THE SKELETON: headings, labels and texts name WHAT is shown, never figures, counts or facts you would have to know — the skeleton is on screen before any data is fetched or checked.
- BE MINIMAL: compact JSON (no whitespace), only the containers the request needs, omit every optional prop you don't use. Latency scales with output length.

EXAMPLE — "Zeige Kursdetails inkl. Teilnehmer als Panes":
{ "tree": { "type":"container", "id":"root", "layout":"stack", "children":[
  { "type":"tabs", "id":"detail_tabs", "tabs":[
    { "label":"Übersicht", "child": { "type":"container", "id":"overview", "layout":"stack", "loading":"skeleton", "children":[ { "type":"text", "id":"overview_text", "content":"" } ] } },
    { "label":"Teilnehmer", "child": { "type":"table", "id":"participants", "loading":"skeleton", "columns":[ { "fieldKey":"name", "label":"Name" }, { "fieldKey":"status", "label":"Status" } ], "rows":[] } }
  ] }
] },
  "dataRequirements":[ { "containerId":"participants", "description":"Teilnehmerliste des Kurses", "fields":[ { "fieldKey":"name", "label":"Name" }, { "fieldKey":"status", "label":"Status" } ] } ] }

EXAMPLE — a KPI/score header ("SEO-Score und Kennzahlen"):
{ "tree": { "type":"container", "id":"root", "layout":"stack", "children":[
  { "type":"container", "id":"scores", "layout":"grid", "loading":"skeleton", "children":[
    { "type":"container", "id":"scores.seo_card", "layout":"stack", "children":[ { "type":"heading", "content":"SEO-Score", "level":4 }, { "type":"text", "id":"scores.seo", "content":"" } ] },
    { "type":"container", "id":"scores.tech_card", "layout":"stack", "children":[ { "type":"heading", "content":"Technical", "level":4 }, { "type":"text", "id":"scores.technical", "content":"" } ] }
  ] }
] },
  "dataRequirements":[ { "containerId":"scores", "description":"SEO-Kennzahlen", "fields":[ { "fieldKey":"seo", "label":"SEO-Score" }, { "fieldKey":"technical", "label":"Technical" } ] } ] }

Output ONLY the JSON object — no code fences, no prose before or after it.`;

type ParsedResult =
  | { ok: true; result: Omit<SkeletonResult, 'source'>; shape: JsonOutputShape }
  | { ok: false; shape: JsonOutputShape };

/** Models routinely ignore "JSON only" and wrap the object in markdown
 *  fences, a preface or a trailing remark — the FIRST balanced top-level
 *  object is the answer (`extractFirstJsonObject`); its validation is
 *  unchanged. */
function parseResult(raw: string, allowedFetchTools: ReadonlySet<string>): ParsedResult {
  const extracted = extractFirstJsonObject(raw);
  if (!extracted.ok) return { ok: false, shape: extracted.shape };
  const { tree, dataRequirements, summary, locale } = extracted.value as {
    tree?: unknown;
    dataRequirements?: unknown;
    summary?: unknown;
    locale?: unknown;
  };
  if (tree === undefined) return { ok: false, shape: 'no-object' };
  const reqs = Array.isArray(dataRequirements)
    ? dataRequirements.filter(
        (r): r is DataRequirement =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as DataRequirement).containerId === 'string' &&
          Array.isArray((r as DataRequirement).fields),
      )
    : [];
  const parsedSummary = allowedFetchTools.size > 0 ? parseSummary(summary) : undefined;
  // kept without a summary too: the fast path then defaults the sentence
  // in this locale instead of discarding a valid plan
  const parsedLocale = allowedFetchTools.size > 0 ? supportedLocale(locale) : undefined;
  return {
    ok: true,
    shape: extracted.shape,
    result: {
      tree,
      dataRequirements: withFetchPlans(reqs, allowedFetchTools),
      ...(parsedSummary !== undefined ? { summary: parsedSummary } : {}),
      ...(parsedLocale !== undefined ? { locale: parsedLocale } : {}),
    },
  };
}

/** `value` with `privacy.restore` applied to every string in it (keys stay). */
function restoreStrings<T>(value: T, privacy: StoredTextPrivacyRun): T {
  if (typeof value === 'string') return privacy.restore(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => restoreStrings(v, privacy)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, restoreStrings(v, privacy)]),
    ) as T;
  }
  return value;
}

/**
 * Compose the skeleton-first tree. One bounded repair retry on schema failure
 * (the retry prompt carries the validator errors); deterministic fallback after
 * that — composition must NEVER block or fail the turn.
 */
export async function composeSkeleton(opts: {
  llm: CompositionLlm;
  model: string;
  userText: string;
  /** observability for the never-throw contract: every fallback states why. */
  log?: (message: string) => void;
  /** #1535 — the text may not reach a model (the org policy requires the
   *  Privacy Shield and none runs): go straight to the fallback. */
  skipModel?: boolean;
  /** #1540 — a privacy guard runs: the text reaches the model masked through
   *  this run, and the output is restored. A run that cannot mask skips the
   *  model call (fallback skeleton). Absent ⇒ the text goes out as written. */
  privacy?: StoredTextPrivacyRun;
  /** Tools the composer may plan a deterministic `fetch` for (the plugin's
   *  `fast_path_tools` with a known spec). Empty/absent: no FAST PATH prompt
   *  section, and every `fetch`/`summary` the model emits anyway is dropped. */
  fastPathTools?: readonly FastPathToolSpec[];
  /** Learned fast path: the top-K active plans most similar to the request,
   *  shown as validated examples (only with fastPathTools; their tools must
   *  be among them to pass the fetch whitelist). */
  learnedExamples?: readonly LearnedExample[];
}): Promise<SkeletonResult> {
  const fastPathTools = opts.fastPathTools ?? [];
  const allowedFetchTools: ReadonlySet<string> = new Set(fastPathTools.map((t) => t.name));
  const system =
    fastPathTools.length > 0
      ? SYSTEM_PROMPT + fastPathPromptSection(fastPathTools, opts.learnedExamples)
      : SYSTEM_PROMPT;
  const fallback: SkeletonResult = {
    tree: structuredClone(FALLBACK_SKELETON),
    dataRequirements: [{ containerId: 'root', description: opts.userText, fields: [] }],
    source: 'fallback',
  };
  if (opts.skipModel === true) {
    opts.log?.('[composition] model call skipped (privacy policy) → fallback skeleton');
    return fallback;
  }

  let requestText = opts.userText;
  if (opts.privacy !== undefined) {
    const masked = await opts.privacy.mask(opts.userText);
    if (!masked.send) {
      opts.log?.(`[composition] model call skipped (privacy: ${masked.reason}) → fallback skeleton`);
      return fallback;
    }
    requestText = masked.text;
  }

  let user = `User request: ${requestText}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: string;
    const startedAt = Date.now();
    try {
      const result = await opts.llm.complete({
        model: opts.model,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 2048,
        ...COMPOSER_REASONING,
      });
      raw = result.text;
      // Latency observability: the skeleton gates the first paint, so every
      // model call logs its duration (a retry doubles the wait).
      opts.log?.(
        `[composition] model call attempt ${attempt + 1}: ${Date.now() - startedAt}ms, ${raw.length} chars`,
      );
    } catch (err) {
      opts.log?.(
        `[composition] llm call failed → fallback skeleton: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fallback;
    }
    const outcome = parseResult(raw, allowedFetchTools);
    if (!outcome.ok) {
      // shape only (empty / unbalanced = cut at max tokens / no-object) —
      // never the output itself, it may carry the user's values
      opts.log?.(
        `[composition] attempt ${attempt + 1}: output not parseable as raw JSON (shape=${outcome.shape}, ${raw.length} chars)`,
      );
      user = `User request: ${requestText}\nYour previous output was not a valid JSON object. Output ONLY the JSON object — no code fences, no prose.`;
      continue;
    }
    if (outcome.shape === 'recovered') {
      opts.log?.(`[composition] attempt ${attempt + 1}: recovered JSON from fenced output`);
    }
    const parsed = outcome.result;
    // Validated on the model's (masked) tree, so a retry prompt built from
    // the validator errors carries no restored value.
    const valid = validateTree(parsed.tree);
    if (valid.ok) {
      // #1540 — real values back into the skeleton's string leaves, after
      // parsing: a restored value cannot break the JSON.
      return opts.privacy === undefined
        ? { ...parsed, source: 'model' }
        : { ...restoreStrings(parsed, opts.privacy), source: 'model' };
    }
    opts.log?.(`[composition] attempt ${attempt + 1}: tree schema-invalid: ${valid.errors}`);
    user = `User request: ${requestText}\nYour previous tree was schema-invalid: ${valid.errors}. Emit a corrected JSON object.`;
  }
  opts.log?.('[composition] both attempts schema-invalid → fallback skeleton');
  return fallback;
}
