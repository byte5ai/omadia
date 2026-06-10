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
}

export interface SkeletonResult {
  tree: unknown;
  dataRequirements: DataRequirement[];
  source: 'model' | 'fallback';
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
- status:    { "type":"status", "text":string }
- divider:   { "type":"divider" }
- table:     { "type":"table", "id", "loading":"skeleton", "columns":[ { "fieldKey":string, "label":string, "type"?:string } ], "rows":[] }
- list:      { "type":"list", "id", "loading":"skeleton", "items":[] }
- chart:     { "type":"chart", "id", "loading":"skeleton", "chartType":string, "points":[] }
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
- A fetched data set may be EMPTY — the table keeps rows:[]; never plan placeholder rows.
- BE MINIMAL: compact JSON (no whitespace), only the containers the request needs, omit every optional prop you don't use. Latency scales with output length.

EXAMPLE — "Zeige Kursdetails inkl. Teilnehmer als Panes":
{ "tree": { "type":"container", "id":"root", "layout":"stack", "children":[
  { "type":"tabs", "id":"detail_tabs", "tabs":[
    { "label":"Übersicht", "child": { "type":"container", "id":"overview", "layout":"stack", "loading":"skeleton", "children":[ { "type":"text", "id":"overview_text", "content":"" } ] } },
    { "label":"Teilnehmer", "child": { "type":"table", "id":"participants", "loading":"skeleton", "columns":[ { "fieldKey":"name", "label":"Name" }, { "fieldKey":"status", "label":"Status" } ], "rows":[] } }
  ] }
] },
  "dataRequirements":[ { "containerId":"participants", "description":"Teilnehmerliste des Kurses", "fields":[ { "fieldKey":"name", "label":"Name" }, { "fieldKey":"status", "label":"Status" } ] } ] }

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

function parseResult(raw: string): { tree: unknown; dataRequirements: DataRequirement[] } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(extractJsonPayload(raw));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const { tree, dataRequirements } = obj as { tree?: unknown; dataRequirements?: unknown };
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
  return { tree, dataRequirements: reqs };
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
}): Promise<SkeletonResult> {
  const fallback: SkeletonResult = {
    tree: structuredClone(FALLBACK_SKELETON),
    dataRequirements: [{ containerId: 'root', description: opts.userText, fields: [] }],
    source: 'fallback',
  };

  let user = `User request: ${opts.userText}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: string;
    const startedAt = Date.now();
    try {
      const result = await opts.llm.complete({
        model: opts.model,
        system: SYSTEM_PROMPT,
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
    const parsed = parseResult(raw);
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
