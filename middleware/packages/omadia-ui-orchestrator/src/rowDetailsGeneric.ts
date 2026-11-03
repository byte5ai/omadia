import type { FastPathDecision, FastPathDecisionStep } from '@omadia/channel-sdk';
import {
  chooseDecision,
  fetchRecipeRows,
  isPlannableReadTool,
  type FastPathService,
  type FastPathToolDefinition,
  type RefreshSource,
} from '@omadia/fast-path';
import type { DecisionOption } from '@omadia/plugin-api';

import { detailViewTree, detailWords, rowDetailsAnswer, rowDetailsAsk, type Lang } from './rowDetails.js';

/**
 * LLM-free "Details anzeigen" for a table ANY read tool filled — plugin
 * tool, sub-agent tool, builder agent — opened through a detail tool of the
 * SAME agent (a `list_*` table through its `get_*`). Integration-agnostic:
 * only tool definitions, the owning agent, the key parameter and the
 * output's shape count. (rowDetails.ts adds catalog labels for odoo_query.)
 *
 *   1. candidates: the offered read tools of the SAME agent as the table's
 *      tool (same `agentId` / `via`) that take ONE key parameter;
 *   2. the decision model (`canvas.detail-tool`) picks one — on fixed text
 *      only (tool names + descriptions, the table's column keys), never a
 *      row value; without one, or unsure, a single candidate is taken as is;
 *   3. the key: the row key when the table keyed its rows by that parameter,
 *      else the parameter's value in the row's record (one re-run of the
 *      table's own recipe);
 *   4. the tool runs directly (its own `invoke` for a sub-agent tool) and its
 *      ONE record renders as a Feld/Wert view. No model sees a value.
 */

export const DETAIL_TOOL_TASK = 'canvas.detail-tool';
/** Below this the decision is not taken (a single candidate still is). */
export const DETAIL_TOOL_MIN_CONFIDENCE = 0.6;
const MAX_FIELDS = 24;
const MAX_TEXT = 600;
const NONE = 'none';
const TOOL_PREFIX = 'tool:';

const DETAIL_INSTRUCTION =
  'A user opened ONE row of the TABLE below and wants that record\'s full details. Pick the tool that returns ' +
  'the details of exactly one record by its key. If none does, pick none.';

type ToolInvoke = (name: string, input: unknown) => Promise<string>;

export type GenericRowDetails =
  | { hit: true; tree: Record<string, unknown>; prose: string; ask: string; tool: string; decision?: FastPathDecision }
  | { hit: false; reason: string };

/** The ONE key parameter of a tool: its single required property, else its
 *  single property. */
export function keyParameter(def: FastPathToolDefinition): { name: string; numeric: boolean } | undefined {
  const schema = def.input_schema as { properties?: Record<string, { type?: unknown }>; required?: unknown } | undefined;
  const props = schema?.properties ?? {};
  const required = Array.isArray(schema?.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [];
  const name = required.length === 1 ? required[0] : Object.keys(props).length === 1 ? Object.keys(props)[0] : undefined;
  if (name === undefined) return undefined;
  const type = props[name]?.type;
  return { name, numeric: type === 'integer' || type === 'number' };
}

/** Detail-tool candidates: same owner as the table's tool, read-named, one key. */
export function detailCandidates(
  definitions: readonly FastPathToolDefinition[],
  tableTool: string,
): FastPathToolDefinition[] {
  const table = definitions.find((d) => d.name === tableTool);
  const owner = table?.agentId ?? table?.via;
  if (owner === undefined) return [];
  return definitions.filter(
    (d) =>
      d.name !== tableTool &&
      (d.agentId ?? d.via) === owner &&
      isPlannableReadTool(d) &&
      keyParameter(d) !== undefined,
  );
}

function firstSentence(text: string | undefined): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  const cut = s.search(/[.!?](\s|$)/);
  return (cut >= 0 ? s.slice(0, cut + 1) : s).slice(0, 200);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The ONE record of a detail answer: the root object, or its only nested
 *  object next to status scalars (`{ ok, record: {…} }`), or a one-element
 *  array. */
export function detailRecord(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) return parsed.length === 1 && isRecord(parsed[0]) ? parsed[0] : undefined;
  if (!isRecord(parsed)) return undefined;
  const nested = Object.values(parsed).filter(isRecord);
  const scalars = Object.values(parsed).filter((v) => !isRecord(v) && !Array.isArray(v));
  return nested.length === 1 && scalars.length <= 2 && Object.keys(parsed).length <= 3 ? nested[0] : parsed;
}

/** Technical keys a person never needs: ids, internal links/handles. */
const SKIP_KEY = /(^|_)(node_id|id)$|^_|_links?$/i;
/** Keys that hold a link to the record itself, shown as "Link" when its
 *  value is a browser URL — every other URL-valued field is API plumbing. */
const LINK_KEY = /(^|_)(html_url|web_url|webui|weburl|link|permalink|browser_url)$/i;
/** Fields that name a nested object (person, label, status, …). */
const NAME_KEYS = ['name', 'displayName', 'display_name', 'title', 'login', 'username', 'email', 'key', 'value'] as const;

const isBrowserUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v);

function label(key: string): string {
  if (LINK_KEY.test(key)) return 'Link';
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function nameOf(v: Record<string, unknown>): string | undefined {
  for (const k of NAME_KEYS) {
    const n = v[k];
    if (typeof n === 'string' && n.trim().length > 0) return n.trim();
  }
  return undefined;
}

function cap(text: string): string {
  const t = text.trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

/** One value as plain text, or undefined to leave the field out. */
function valueText(v: unknown, lang: Lang): string | undefined {
  const w = detailWords(lang);
  if (v === null || v === undefined || v === '') return w.empty;
  if (typeof v === 'boolean') return v ? w.yes : w.no;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return cap(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return w.empty;
    if (v.every((e) => ['string', 'number', 'boolean'].includes(typeof e))) return cap(v.join(', '));
    const names = v.filter(isRecord).map(nameOf);
    if (names.every((n) => n !== undefined)) return cap(names.join(', '));
    return lang === 'de' ? `${String(v.length)} Einträge` : `${String(v.length)} entries`;
  }
  return isRecord(v) ? nameOf(v) : undefined;
}

/** The record's fields for the Feld/Wert view, in its own key order. */
export function detailFields(record: Readonly<Record<string, unknown>>, lang: Lang): Array<{ key: string; field: string; value: string }> {
  const out: Array<{ key: string; field: string; value: string }> = [];
  for (const [key, v] of Object.entries(record)) {
    if (out.length >= MAX_FIELDS) break;
    if (SKIP_KEY.test(key)) continue;
    // a URL is shown only as the record's own link, never API plumbing
    if (isBrowserUrl(v) && !LINK_KEY.test(key)) continue;
    const value = valueText(v, lang);
    if (value !== undefined) out.push({ key, field: label(key), value });
  }
  return out;
}

function recordTitle(record: Readonly<Record<string, unknown>>): string | undefined {
  const t = record['title'] ?? record['name'];
  const n = record['number'];
  const base = typeof t === 'string' && t.trim().length > 0 ? t.trim() : undefined;
  if (base !== undefined && typeof n === 'number') return `#${String(n)} ${base}`;
  return base ?? (typeof n === 'number' ? `#${String(n)}` : undefined);
}

/** Ask the decision model which candidate fetches one record's details. */
async function pickTool(opts: {
  fp: FastPathService;
  recipe: RefreshSource;
  table: FastPathToolDefinition | undefined;
  candidates: readonly FastPathToolDefinition[];
  log: (m: string) => void;
  steps: FastPathDecisionStep[];
}): Promise<{ def: FastPathToolDefinition; confidence: number; model?: string } | undefined> {
  const single = opts.candidates.length === 1 ? opts.candidates[0] : undefined;
  const decide = opts.fp.decisionModel();
  if (!decide) return single ? { def: single, confidence: 1 } : undefined;
  const options: DecisionOption[] = [
    ...opts.candidates.map((d) => ({
      id: `${TOOL_PREFIX}${d.name}`,
      description: `${d.name} (key: ${keyParameter(d)?.name ?? '?'}): ${firstSentence(d.description)}`,
    })),
    { id: NONE, description: 'no listed tool returns the details of one record' },
  ];
  // fixed text only: the table's tool + its column keys, never a row value
  const input =
    `TABLE: rows from ${opts.recipe.tool} — ${firstSentence(opts.table?.description)} ` +
    `Columns: ${Object.keys(opts.recipe.map).join(', ')}. Row key: ${opts.recipe.rowKey ?? 'none'}.`;
  const result = await chooseDecision(
    decide,
    { task: DETAIL_TOOL_TASK, instruction: DETAIL_INSTRUCTION, input, options },
    opts.log,
    (s) => opts.steps.push(s),
  );
  const picked = result && result.choice !== NONE && result.confidence >= DETAIL_TOOL_MIN_CONFIDENCE
    ? opts.candidates.find((d) => `${TOOL_PREFIX}${d.name}` === result.choice)
    : undefined;
  if (picked) return { def: picked, confidence: result!.confidence, ...(result!.model ? { model: result!.model } : {}) };
  return single ? { def: single, confidence: result?.confidence ?? 1 } : undefined;
}

/** The key value for the detail call: the row key when the table keyed
 *  its rows by the parameter, else the parameter of the row's record. */
async function keyValue(opts: {
  recipe: RefreshSource;
  rowKey: string;
  param: { name: string; numeric: boolean };
  invoke: ToolInvoke;
  timeZone: string;
}): Promise<string | number | undefined> {
  const coerce = (v: unknown): string | number | undefined => {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string' || v.length === 0) return undefined;
    return opts.param.numeric && /^\d{1,15}$/.test(v) ? Number(v) : opts.param.numeric ? undefined : v;
  };
  if (opts.recipe.rowKey === opts.param.name) return coerce(opts.rowKey);
  if (opts.recipe.rowKey === undefined) return undefined;
  const fetched = await fetchRecipeRows(opts.invoke, opts.recipe, { timeZone: opts.timeZone });
  if (!fetched.ok) return undefined;
  const rowKeyAttr = opts.recipe.rowKey;
  const record = fetched.records.find((r) => String(r[rowKeyAttr]) === opts.rowKey);
  return record ? coerce(record[opts.param.name]) : undefined;
}

export async function genericRowDetails(opts: {
  fp: FastPathService;
  recipe: RefreshSource;
  rowKey: string;
  definitions: readonly FastPathToolDefinition[];
  permitted: ReadonlySet<string>;
  baseInvoke: ToolInvoke;
  lang: Lang;
  log: (m: string) => void;
}): Promise<GenericRowDetails> {
  const t0 = Date.now();
  const miss = (reason: string): GenericRowDetails => ({ hit: false, reason });
  const candidates = detailCandidates(opts.definitions, opts.recipe.tool).filter((d) => opts.permitted.has(d.name));
  if (candidates.length === 0) return miss('no-detail-tool');
  const steps: FastPathDecisionStep[] = [];
  const table = opts.definitions.find((d) => d.name === opts.recipe.tool);
  const picked = await pickTool({ fp: opts.fp, recipe: opts.recipe, table, candidates, log: opts.log, steps });
  if (!picked) return miss('detail-tool-undecided');
  const param = keyParameter(picked.def);
  if (!param) return miss('no-key-parameter');
  const own = new Map(opts.definitions.filter((d) => d.invoke).map((d) => [d.name, d.invoke!]));
  const invoke: ToolInvoke = (name, input) => own.get(name)?.(input) ?? opts.baseInvoke(name, input);
  const key = await keyValue({ recipe: opts.recipe, rowKey: opts.rowKey, param, invoke, timeZone: opts.fp.timeZone });
  if (key === undefined) return miss('key-unresolved');
  let raw: string;
  try {
    raw = await invoke(picked.def.name, { [param.name]: key });
  } catch {
    return miss('invoke-error');
  }
  if (/^\s*Error\b/.test(raw)) return miss('tool-error');
  const record = detailRecord(raw);
  if (!record) return miss('no-record');
  const fields = detailFields(record, opts.lang);
  if (fields.length === 0) return miss('no-fields');
  const title = recordTitle(record);
  const provider = opts.fp.decisionModel()?.provider;
  const decision: FastPathDecision | undefined =
    provider !== undefined && steps.length > 0
      ? {
          provider,
          ...(picked.model !== undefined ? { model: picked.model } : {}),
          verdict: 'data',
          tool: picked.def.name,
          confidence: picked.confidence,
          ms: Date.now() - t0,
          answered: true,
          steps,
        }
      : undefined;
  return {
    hit: true,
    tree: detailViewTree(title, fields, opts.lang),
    prose: rowDetailsAnswer(title, opts.lang),
    ask: rowDetailsAsk(picked.def.name, key, opts.lang),
    tool: picked.def.name,
    ...(decision ? { decision } : {}),
  };
}
