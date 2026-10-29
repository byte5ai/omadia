import {
  isTruncatedOutput,
  mapRefreshRecords,
  requiresCompleteResult,
  resolveRecipeInput,
  type RefreshSource,
} from './refreshRecipes.js';
import { extractFirstJsonObject } from './jsonExtract.js';

/**
 * Deterministic canvas fast path — the building blocks.
 *
 * A simple canvas ask ("Geburtstage im Januar") does not need the agent loop
 * (main model → sub-agent → main model, ~15 s+ before any verifier): the
 * skeleton composer already reads the request, so for an allow-listed read
 * tool it also plans the ONE query that fills each container (a `fetch`
 * refresh recipe, see refreshRecipes.ts) and a prose template. The plugin
 * then runs the query itself, maps the rows deterministically and publishes
 * them through the same synthesis path the LLM-free refresh uses. No model
 * ever sees the rows. Any miss falls back to the agent path unchanged.
 */

/** A tool a fast-model planner may plan a deterministic `fetch` for: its
 *  name and a compact input/output spec the planner builds the query from. */
export interface FastPathToolSpec {
  name: string;
  spec: string;
}

/** Narrow LLM port — structurally satisfied by `ctx.llm` (LlmAccessor);
 *  injected so planning is testable without network or SDK coupling. */
export interface FastLlm {
  complete(req: {
    model: string;
    system?: string;
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
    effort?: 'low' | 'medium' | 'high' | 'xhigh';
    thinking?: 'off';
    /** structured output by a forced tool call (router, planner) */
    tools?: ReadonlyArray<FastLlmTool>;
    toolChoice?: { name: string };
  }): Promise<{ text: string; toolCalls?: ReadonlyArray<{ name: string; input: unknown }> }>;
}

/** A tool definition for a forced structured-output call (`ctx.llm`
 *  `LlmToolDefinition`): no `additionalProperties:false` needed. */
export interface FastLlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The input of the forced `tool` call, else (a model that cannot force a
 *  tool answered in text) the first JSON object of the text; undefined when
 *  neither is an object. */
export function forcedToolInput(
  res: { text: string; toolCalls?: ReadonlyArray<{ name: string; input: unknown }> },
  tool: string,
): { value: Record<string, unknown>; via: 'tool' | 'text' } | undefined {
  const call = res.toolCalls?.find((c) => c.name === tool);
  if (call !== undefined) {
    return typeof call.input === 'object' && call.input !== null && !Array.isArray(call.input)
      ? { value: call.input as Record<string, unknown>, via: 'tool' }
      : undefined;
  }
  const extracted = extractFirstJsonObject(res.text);
  return extracted.ok ? { value: extracted.value, via: 'text' } : undefined;
}

/**
 * Every fast-path planning call (canvas composer, in-place planner, chat
 * triage) gates the first answer of a turn, so it asks for the lowest-latency
 * reasoning: thinking off where the model accepts it (Haiku 5.5 — on by
 * default there) and low effort as the lever every effort-capable model
 * honours. Both are hints the provider ignores where they do not apply.
 * Planning is pattern-following, not reasoning — a measured 3.4–10 s on
 * adaptive thinking.
 */
export const FAST_MODEL_REASONING = { effort: 'low', thinking: 'off' } as const;

/**
 * The output-format instruction every fast-path planning call (composer,
 * triage) carries in its FIRST user message as well as in the system prompt:
 * Haiku with thinking off frequently answered attempt 1 with prose when only
 * the system prompt asked for JSON (live self-test v411).
 */
export const OUTPUT_FORMAT_INSTRUCTION = 'Output ONLY the JSON object — no code fences, no prose before or after it.';

/** Allow-list when `fast_path_tools` is not configured at all. */
export const DEFAULT_FAST_PATH_TOOLS: readonly string[] = ['odoo_query'];

/**
 * Compact composer-facing input specs. `ToolsAccessor` exposes no spec
 * lookup, so a tool can be planned only when its spec is known here; an
 * allow-listed tool without one is ignored (logged at activation). Mirrors
 * `odooQueryToolSpec` in omadia-integration-odoo (odooReadTools.ts): the
 * output envelope `{ model, scope, count, truncated, records }`, limit capped
 * at 100, many2one values as `[id, "Display Name"]`, empty values as false.
 *
 * The field catalog is deliberately small (token budget — it rides on every
 * canvas turn): Odoo 17/18 standard fields of the models the integration
 * whitelists (odooCore.ts ALLOWED_MODELS), none of its HR red-line fields.
 */
export const FAST_PATH_TOOL_SPECS: Readonly<Record<string, string>> = {
  odoo_query:
    'odoo_query — Odoo search_read (read-only). input: { "model": string, "domain"?: Odoo domain e.g. ' +
    '[["department_id.name","ilike","Sales"]] (archived records are excluded by default), ' +
    '"fields"?: string[], "limit": 100 (limit is always 100 — also for a single-record lookup by id; a full result of 100 counts as truncated), ' +
    '"order"?: e.g. "name asc" }. output: { "records": [ { field: value } ], "truncated": boolean } ' +
    '→ itemsPath "records", rowKey "id". many2one fields are [id, "Name"] → map them as ' +
    '"<field>.1". Empty values are false. FIELD CATALOG (plan only with these):\n' +
    '  · hr.employee: name, job_title, department_id, parent_id, work_email, work_phone, active, ' +
    'birthday (date "YYYY-MM-DD" — a month needs a datePart filter, Odoo cannot filter it). ' +
    'HR wage/bank/private fields are blocked.\n' +
    '  · res.partner: name, email, phone, city, is_company, customer_rank (>0 = customer), ' +
    'supplier_rank (>0 = supplier).\n' +
    '  · account.move (invoices): name (number), partner_id, invoice_date, invoice_date_due, ' +
    'amount_total, amount_residual (open amount, number), currency_id, state (draft|posted|cancel), ' +
    'payment_state (not_paid|partial|in_payment|paid), move_type (out_invoice = Kundenrechnung, ' +
    'in_invoice = Lieferantenrechnung, out_refund / in_refund = Gutschrift). Amounts are in each ' +
    'invoice\'s currency_id: whenever a {sum:…} totals an amount, ALWAYS add "currency_id" to "fields" — ' +
    'the total is shown only when every row has one currency.\n' +
    '  TERMS: "offene Posten"/"open items"/"offene Rechnungen"/"Debitoren"/"receivables" = account.move ' +
    'domain [["move_type","=","out_invoice"],["state","=","posted"],["payment_state","in",["not_paid","partial"]]], ' +
    'fields name, partner_id, invoice_date_due, amount_residual, currency_id, order "invoice_date_due asc"; ' +
    '"Lieferanten"/"Kreditoren"/"Verbindlichkeiten"/"payables" → "in_invoice" instead; ' +
    '"überfällig"/"overdue" → add ["invoice_date_due","<","{today}"]. ' +
    '"Kunden"/"customers" = res.partner [["customer_rank",">",0]], "suppliers" = [["supplier_rank",">",0]]. ' +
    'DATES: a domain value "{today}" / "{today-30d}" / "{today+7d}" (whole string) resolves to the ' +
    'date at execution — never write the current date literally.',
};

/** One-line purposes of the built-in tools for the router's tool catalog
 *  (the full spec is the planner's). A tool without one — a learned read
 *  tool — gets the first sentence of its spec. */
export const FAST_PATH_TOOL_PURPOSES: Readonly<Record<string, string>> = {
  odoo_query:
    'Odoo ERP read-only lookup: employees (names, departments, birthdays, contacts), partners/customers/suppliers, ' +
    'invoices and open items (receivables/payables, due dates, open amounts).',
};

/** The router's one-line purpose of `spec`. */
export function toolPurpose(spec: FastPathToolSpec): string {
  const known = FAST_PATH_TOOL_PURPOSES[spec.name];
  if (known !== undefined) return known;
  const text = spec.spec.replace(/\s+/g, ' ').trim();
  const end = text.search(/[.:]\s/);
  return (end > 0 ? text.slice(0, end) : text).slice(0, 160);
}

/** Parse the `fast_path_tools` setup field: unset → the default allow-list;
 *  an explicit empty value disables the fast path. */
export function parseFastPathTools(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_FAST_PATH_TOOLS];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The allow-listed tools the composer can plan for (spec known). */
export function plannableTools(allowed: readonly string[]): FastPathToolSpec[] {
  return allowed.flatMap((name) => {
    const spec = FAST_PATH_TOOL_SPECS[name];
    return spec === undefined ? [] : [{ name, spec }];
  });
}

/** `{sum:<fieldKey>}` in the composer's prose template. */
export const SUM_PLACEHOLDER = /\{sum:([A-Za-z0-9_.-]+)\}/g;

const MAX_SUMMARY_CHARS = 280;
const COUNT_PLACEHOLDER = '{count}';

/** A planner's prose template, kept only with at least one placeholder — a
 *  fixed sentence could not be correct for every result. */
export function parseSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (s.length === 0 || s.length > MAX_SUMMARY_CHARS) return undefined;
  return s.includes(COUNT_PLACEHOLDER) || new RegExp(SUM_PLACEHOLDER.source).test(s) ? s : undefined;
}

/** Words that only (or overwhelmingly) occur in German requests. */
const GERMAN_HINT =
  /[äöüß]|\b(?:der|die|das|und|im|von|mit|für|wie|viele|alle|welche|zeig|zeige|mir|ist|sind|haben|hat|offene|nach|bis|seit|heute|gestern|monat|jahr)\b/i;

/** The planner's locale, else a German/English guess from the request. */
export function summaryLanguage(locale: string | undefined, question?: string): 'de' | 'en' {
  if (locale !== undefined) return locale.toLowerCase().startsWith('de') ? 'de' : 'en';
  return question !== undefined && GERMAN_HINT.test(question) ? 'de' : 'en';
}

/**
 * The deterministic summary for an otherwise valid plan whose planner
 * emitted none (or one without a placeholder): states only the row count, so
 * it is correct for every result. A missing sentence is no reason to discard
 * a valid query — the rows ARE the answer.
 */
export function defaultSummary(locale: string | undefined, question?: string): string {
  return summaryLanguage(locale, question) === 'de' ? '{count} Einträge gefunden.' : '{count} results found.';
}

export type RenderedSummary = { ok: true; text: string } | { ok: false; detail: string };

/** A canonical, runtime-supported BCP-47 tag, else undefined. */
export function supportedLocale(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 35) return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(raw);
    return canonical !== undefined && Intl.NumberFormat.supportedLocalesOf(canonical).length > 0
      ? canonical
      : undefined;
  } catch {
    return undefined; // RangeError: not a well-formed tag
  }
}

/** Summed attributes treated as MONEY (Odoo naming: amount_*, price_*,
 *  balance, debit, credit) — a total of those needs one currency. Matched
 *  on the record attribute the fieldKey maps to, so it holds whatever the
 *  composer named the column. Deliberately broad: a false positive only
 *  costs a fast-path miss, a false negative could print a mixed total. */
const MONETARY_ATTR = /amount|price|balance|debit|credit|residual|subtotal/i;

/** Record attribute carrying a monetary row's currency (Odoo many2one). */
export const CURRENCY_ATTR = 'currency_id';

/** Currency identity of a raw record: the many2one id (`[id, "EUR"]`), or
 *  a plain scalar; undefined when absent/empty (Odoo `false`). */
function currencyOf(rec: Record<string, unknown>): string | undefined {
  const v = rec[CURRENCY_ATTR];
  const id: unknown = Array.isArray(v) ? v[0] : v;
  return typeof id === 'number' || (typeof id === 'string' && id.length > 0) ? String(id) : undefined;
}

/** null when the money behind `attr` is in ONE currency (or `attr` is not
 *  money), else why not. `records[i]` is the raw record behind `rows[i]`. */
function mixedCurrency(attr: string, rowCount: number, records: ReadonlyArray<Record<string, unknown>>): string | null {
  if (!MONETARY_ATTR.test(attr)) return null;
  if (records.length !== rowCount) return 'raw records not aligned with the rows';
  const seen = new Set<string>();
  for (const rec of records) {
    const c = currencyOf(rec);
    if (c === undefined) return `a row without ${CURRENCY_ATTR}`;
    seen.add(c);
  }
  return seen.size > 1 ? `${seen.size} currencies` : null;
}

/** Exact column total, or why there is none. */
function sumColumn(key: string, rows: ReadonlyArray<Record<string, unknown>>): number | string {
  let total = 0;
  for (const row of rows) {
    const v = row[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'a non-numeric value';
    total += v;
  }
  return total;
}

/**
 * Fill the composer's prose template from the published rows of the FIRST
 * data requirement (after the filter): `{count}` = row count,
 * `{sum:<fieldKey>}` = the column total with two decimals in `locale`
 * (de: `51.230,00`), `{currency}` = the display value of the ONE shared
 * `currency_id` behind a money sum (dropped for zero rows; without a money
 * sum in the template it cannot be resolved → `ok: false`). A sum is
 * printed only when it is exact — the key one of the container's fieldKeys
 * (`map`), every value a finite number, a valid locale and, for money, ONE
 * `currency_id` across the raw `records` — otherwise the result is
 * `ok: false` and the caller misses rather than state a wrong figure.
 */
export function renderSummary(
  template: string,
  opts: {
    rows: ReadonlyArray<Record<string, unknown>>;
    /** raw records behind the rows, index-aligned (mapRefreshRecords) */
    records: ReadonlyArray<Record<string, unknown>>;
    /** the recipe's fieldKey → record attribute map */
    map: Readonly<Record<string, string>>;
    locale?: string;
  },
): RenderedSummary {
  const sums = new Map<string, string>();
  let moneyChecked = false;
  for (const [, key] of template.matchAll(SUM_PLACEHOLDER)) {
    if (key === undefined || sums.has(key)) continue;
    const attr = opts.map[key];
    if (attr === undefined) return { ok: false, detail: `{sum:${key}} is not a column` };
    const locale = supportedLocale(opts.locale);
    if (locale === undefined) return { ok: false, detail: `{sum:${key}} without a valid locale` };
    const total = sumColumn(key, opts.rows);
    if (typeof total === 'string') return { ok: false, detail: `{sum:${key}} over ${total}` };
    const mixed = mixedCurrency(attr, opts.rows.length, opts.records);
    if (mixed !== null) return { ok: false, detail: `{sum:${key}} (${attr}): ${mixed}` };
    if (MONETARY_ATTR.test(attr)) moneyChecked = true;
    sums.set(
      key,
      new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(total),
    );
  }
  let withCurrency = template;
  if (template.includes(CURRENCY_PLACEHOLDER)) {
    // only next to a money total whose ONE currency was just verified
    if (!moneyChecked) return { ok: false, detail: `${CURRENCY_PLACEHOLDER} without a currency-checked money {sum:…}` };
    const first = opts.records[0];
    const name = first !== undefined ? currencyDisplay(first) : undefined;
    if (first !== undefined && name === undefined) {
      return { ok: false, detail: `${CURRENCY_PLACEHOLDER}: ${CURRENCY_ATTR} has no display value` };
    }
    // zero rows: no currency to state — drop the token with its leading space
    withCurrency =
      name === undefined
        ? template.replace(/\s?\{currency\}/g, '')
        : template.split(CURRENCY_PLACEHOLDER).join(name);
  }
  const text = withCurrency
    .replace(SUM_PLACEHOLDER, (_m, key: string) => sums.get(key) ?? '')
    .split('{count}')
    .join(String(opts.rows.length));
  return { ok: true, text };
}

/** `{currency}` — the shared currency of a currency-checked money `{sum:…}`. */
export const CURRENCY_PLACEHOLDER = '{currency}';

/** Display value of a record's currency: the many2one name (`[1, "EUR"]` →
 *  `EUR`) or a plain string; undefined when absent/empty. */
function currencyDisplay(rec: Record<string, unknown>): string | undefined {
  const v = rec[CURRENCY_ATTR];
  const name: unknown = Array.isArray(v) ? v[1] : v;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/** Row cap of `odoo_query` (its `limit` maximum). */
export const ODOO_QUERY_MAX_LIMIT = 100;

/**
 * A planner sets `limit: 1` for a single-record lookup, and odoo_query flags
 * `truncated` as soon as the row count reaches the limit (1 of 1) — a
 * spurious miss. On the fast path every odoo_query runs with the tool maximum
 * instead: an id lookup still returns its one row, and `truncated` keeps
 * meaning a genuinely large result. Returns a copy; other tools unchanged.
 */
export function normalizeFastPathInput(tool: string, input: unknown): unknown {
  if (tool !== 'odoo_query' || typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  return { ...(input as Record<string, unknown>), limit: ODOO_QUERY_MAX_LIMIT };
}

export type ToolInvoke = (name: string, input: unknown) => Promise<string>;

export type RecipeFetch =
  | {
      ok: true;
      rows: Array<Record<string, unknown>>;
      /** raw records behind `rows`, index-aligned (after the filter) */
      records: Array<Record<string, unknown>>;
      ms: number;
    }
  | {
      ok: false;
      reason: 'tool-unavailable' | 'invoke-error' | 'tool-error' | 'truncated' | 'unmappable';
      detail?: string;
    };

/** Native-registry miss as thrown by the kernel's `ctx.tools.invoke`. */
const UNAVAILABLE = /unknown or handler-less/;

/**
 * Replay one recipe and map its rows — shared by `canvas_refresh` and the
 * fast path. Never throws. `rejectTruncated` refuses a result the tool flags
 * as capped (the fast path's prose states a count, which a prefix would get
 * wrong) and runs an odoo_query with the tool's maximum limit
 * (normalizeFastPathInput); a recipe with a `filter`, `sort` or `take` refuses it either way
 * (requiresCompleteResult).
 */
export async function fetchRecipeRows(
  invoke: ToolInvoke,
  recipe: RefreshSource,
  opts: { rejectTruncated?: boolean; timeZone?: string } = {},
): Promise<RecipeFetch> {
  const t0 = Date.now();
  let raw: string;
  try {
    // `{today}` tokens resolve per execution; the recipe itself keeps them
    const input = opts.rejectTruncated === true ? normalizeFastPathInput(recipe.tool, recipe.input) : recipe.input;
    raw = await invoke(recipe.tool, resolveRecipeInput(input, new Date(), opts.timeZone));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: UNAVAILABLE.test(detail) ? 'tool-unavailable' : 'invoke-error', detail };
  }
  // tools report failures as an `Error: …` string result, not a throw
  if (/^\s*Error\b/.test(raw)) return { ok: false, reason: 'tool-error', detail: raw.slice(0, 200) };
  if (opts.rejectTruncated === true && isTruncatedOutput(raw)) return { ok: false, reason: 'truncated' };
  const mapped = mapRefreshRecords(raw, recipe);
  if (mapped === null) {
    return { ok: false, reason: requiresCompleteResult(recipe) && isTruncatedOutput(raw) ? 'truncated' : 'unmappable' };
  }
  return { ok: true, rows: mapped.rows, records: mapped.records, ms: Date.now() - t0 };
}
