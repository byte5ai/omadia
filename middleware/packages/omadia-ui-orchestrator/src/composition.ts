import { parseRefreshSource, type RefreshSource } from './refreshRecipes.js';
import { validateTree } from './treeValidator.js';

/**
 * Tier-2 skeleton composition (PR-9b-2): one fast-model call turns the user's
 * request into (a) a schema-valid skeleton tree the client renders immediately
 * and (b) the data requirements the delegated main turn must satisfy — so
 * Tier-3 sub-agents return payloads matching exactly the fields the skeleton
 * promised.
 */

/** Narrow LLM port — structurally satisfied by `ctx.llm` (LlmAccessor); injected
 *  so composition is testable without network or SDK coupling. */
export interface CompositionLlm {
  complete(req: {
    model: string;
    system?: string;
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
  }): Promise<{ text: string }>;
}

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
  /** fast-path prose template in the user's language; carries `{count}`. */
  summary?: string;
}

/** A tool the composer may plan a fast-path `fetch` for: its name and a
 *  compact input/output spec the composer builds the query from. */
export interface FastPathToolSpec {
  name: string;
  spec: string;
}

const MAX_SUMMARY_CHARS = 280;
const COUNT_PLACEHOLDER = '{count}';

/** The FAST PATH section appended to the composer prompt when at least one
 *  tool is allow-listed — absent otherwise, so the prompt is unchanged. */
function fastPathPromptSection(tools: readonly FastPathToolSpec[]): string {
  return `

FAST PATH (optional — same JSON object, two extra keys): when the request is answered by exactly ONE read query per data container with one of the tools below (plus at most a simple equality/date-part post-filter), add to that dataRequirements entry:
  "fetch": { "tool", "input": <the EXACT tool input>, "map": { fieldKey: <record attribute> }, "rowKey"?: <attribute with a stable id>, "itemsPath"?: <dot-path to the record array>, "filter"?: [ { "field": <attribute>, "datePart": "year"|"month"|"day", "eq": <integer> } | { "field": <attribute>, "eq": <string|number|boolean> } ] }
and a top-level "summary": ONE plain sentence in the user's language containing the placeholder {count} (= number of rows of the FIRST dataRequirement after the filter), correct for any count including 0 — e.g. "{count} Mitarbeitende haben im Januar Geburtstag.". The summary states ONLY what the query guarantees; never invent figures.
- "map" covers EVERY fieldKey of the container's columns. A map value may be a dot-path into the record (e.g. "department_id.1").
- "filter" is for what the tool cannot filter itself (e.g. a birthday MONTH); put everything else into the tool's own query.
- Express relative periods time-safely or omit fetch. OMIT fetch (and summary) whenever the request needs reasoning, joins, aggregation, several steps, a tool not listed, or you are unsure of the field names — the full agent then handles it. A wrong fetch is worse than none.
TOOLS:
${tools.map((t) => `- ${t.spec}`).join('\n')}`;
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
    return fetch && allowed.has(fetch.tool) ? { ...rest, fetch } : rest;
  });
}

function parseSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s.length > 0 && s.length <= MAX_SUMMARY_CHARS && s.includes(COUNT_PLACEHOLDER)
    ? s
    : undefined;
}

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

Output raw JSON only — no prose, no markdown fences.`;

/** Models routinely ignore "raw JSON only" and wrap the object in markdown
 *  fences or a prose preamble — extract the JSON payload before parsing. */
function extractJsonPayload(raw: string): string {
  let s = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fenced?.[1]) s = fenced[1].trim();
  if (!s.startsWith('{')) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
  }
  return s;
}

function parseResult(
  raw: string,
  allowedFetchTools: ReadonlySet<string>,
): { tree: unknown; dataRequirements: DataRequirement[]; summary?: string } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(extractJsonPayload(raw));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const { tree, dataRequirements, summary } = obj as {
    tree?: unknown;
    dataRequirements?: unknown;
    summary?: unknown;
  };
  if (tree === undefined) return null;
  const reqs = Array.isArray(dataRequirements)
    ? dataRequirements.filter(
        (r): r is DataRequirement =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as DataRequirement).containerId === 'string' &&
          Array.isArray((r as DataRequirement).fields),
      )
    : [];
  const parsedSummary = parseSummary(summary);
  return {
    tree,
    dataRequirements: withFetchPlans(reqs, allowedFetchTools),
    ...(parsedSummary !== undefined && allowedFetchTools.size > 0 ? { summary: parsedSummary } : {}),
  };
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
  /** Tools the composer may plan a deterministic `fetch` for (the plugin's
   *  `fast_path_tools` with a known spec). Empty/absent: no FAST PATH prompt
   *  section, and every `fetch`/`summary` the model emits anyway is dropped. */
  fastPathTools?: readonly FastPathToolSpec[];
}): Promise<SkeletonResult> {
  const fastPathTools = opts.fastPathTools ?? [];
  const allowedFetchTools: ReadonlySet<string> = new Set(fastPathTools.map((t) => t.name));
  const system =
    fastPathTools.length > 0 ? SYSTEM_PROMPT + fastPathPromptSection(fastPathTools) : SYSTEM_PROMPT;
  const fallback: SkeletonResult = {
    tree: structuredClone(FALLBACK_SKELETON),
    dataRequirements: [{ containerId: 'root', description: opts.userText, fields: [] }],
    source: 'fallback',
  };
  if (opts.skipModel === true) {
    opts.log?.('[composition] model call skipped (privacy policy) → fallback skeleton');
    return fallback;
  }

  let user = `User request: ${opts.userText}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: string;
    const startedAt = Date.now();
    try {
      const result = await opts.llm.complete({
        model: opts.model,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 2048,
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
    const parsed = parseResult(raw, allowedFetchTools);
    if (!parsed) {
      opts.log?.(`[composition] attempt ${attempt + 1}: output not parseable as raw JSON`);
      user = `User request: ${opts.userText}\nYour previous output was not valid raw JSON. Emit ONLY the JSON object.`;
      continue;
    }
    const valid = validateTree(parsed.tree);
    if (valid.ok) {
      return { ...parsed, source: 'model' };
    }
    opts.log?.(`[composition] attempt ${attempt + 1}: tree schema-invalid: ${valid.errors}`);
    user = `User request: ${opts.userText}\nYour previous tree was schema-invalid: ${valid.errors}. Emit a corrected JSON object.`;
  }
  opts.log?.('[composition] both attempts schema-invalid → fallback skeleton');
  return fallback;
}
