/**
 * The boundary check of a data plan (spec 2042 §5.13 step 1a, criterion 35).
 *
 * Before a data action runs — a side-channel `deliver_data`, a trigger's data
 * check or delivery, a fast-lane plan, and again before a cached plan is
 * reused — its DESCRIPTION is checked against the agent's boundaries: tool,
 * input keys, filters, order, grouping and top-N. Never data, never the
 * literal values of the input (those can name people).
 *
 * Boundary presets map to deterministic constraints where possible
 * ({@link checkDataPlanPresets}); free-text boundaries are judged by a model
 * on the description ({@link DataPlanGuard} implementations). A violation
 * refuses the action, and the agent answers honestly.
 */

/** What a data plan does, without any value it would read or filter by. */
export interface DataPlanDescription {
  /** The read tool. */
  readonly tool: string;
  /** Top-level keys of the tool input (values left out). */
  readonly inputKeys: readonly string[];
  /** Fields or models the input names as strings (e.g. Odoo `model`,
   *  `order`, `group_by`, `fields`): identifiers, not user values. */
  readonly inputIdentifiers: readonly string[];
  /** Sort keys, primary first. */
  readonly sort: readonly { readonly field: string; readonly dir: 'asc' | 'desc' }[];
  /** Fields the rows are grouped by. */
  readonly groupBy: readonly string[];
  /** Keep only the first N rows (a top-N). */
  readonly take?: number;
  /** Fields the plan filters on (values left out). */
  readonly filterFields: readonly string[];
}

export type DataPlanVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly layer: 'preset' | 'model' };

/** The agent's check of one plan description. Fails closed. */
export type DataPlanGuard = (plan: DataPlanDescription) => Promise<DataPlanVerdict>;

/** Input keys naming the records read (a model, an entity, columns). */
const SUBJECT_KEYS = /^(model|entity|table|object|resource|fields|columns|select)$/i;
/** Input keys naming the order. */
const ORDER_KEYS = /^(order|order_?by|sort|sort_?by)$/i;
/** Input keys naming the grouping. */
const GROUP_KEYS = /^(group_?by|groupby|aggregate)$/i;

/** Field or model names that stand for individual people or customers. */
const INDIVIDUAL =
  /(^|[^a-z])(customers?|clients?|partners?|contacts?|persons?|people|employees?|staff|users?|leads?|members?|debtors?|creditors?|vendors?|suppliers?|kunden?|mitarbeiter|personen|ansprechpartner|lieferanten?)([^a-z]|$)|res\.partner|hr\.employee|res\.users/i;

/** Field identifiers out of an `order` / `group_by` style value. */
function identifiersOf(value: unknown): string[] {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return raw
    .flatMap((v) => v.split(/[\s,]+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 120 && !/^(asc|desc)$/i.test(s));
}

/**
 * The description of one tool call: its keys, the identifiers it names as
 * subject, order and grouping, and a top-N (`limit` under an order). Never
 * any other value of the input.
 */
export function describeToolCall(tool: string, input: unknown): DataPlanDescription {
  const record = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const subject: string[] = [];
  const sort: { field: string; dir: 'asc' | 'desc' }[] = [];
  const groupBy: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (SUBJECT_KEYS.test(key)) subject.push(...identifiersOf(value));
    else if (GROUP_KEYS.test(key)) groupBy.push(...identifiersOf(value));
    else if (ORDER_KEYS.test(key)) {
      const desc = typeof value === 'string' && /\bdesc\b/i.test(value);
      for (const field of identifiersOf(value)) sort.push({ field, dir: desc ? 'desc' : 'asc' });
    }
  }
  const limit = record['limit'];
  return {
    tool,
    inputKeys: Object.keys(record).slice(0, 50),
    inputIdentifiers: subject.slice(0, 50),
    sort,
    groupBy,
    ...(sort.length > 0 && typeof limit === 'number' && limit > 0 ? { take: limit } : {}),
    filterFields: [],
  };
}

/** Does the plan rank or compare individuals (people, customers)? */
export function ranksIndividuals(plan: DataPlanDescription): boolean {
  // Ordered or grouped BY an individual (per customer, top employees).
  if ([...plan.sort.map((s) => s.field), ...plan.groupBy].some((f) => INDIVIDUAL.test(f))) return true;
  // An order or a top-N over records that ARE individuals (a customer list).
  const ordered = plan.sort.length > 0 || plan.take !== undefined;
  return ordered && plan.inputIdentifiers.some((id) => INDIVIDUAL.test(id) && /\.|^(customers?|kunden?|employees?|mitarbeiter|partners?|contacts?)$/i.test(id));
}

/** The deterministic constraint behind a boundary preset, where one exists. */
const PRESET_CONSTRAINTS: Readonly<Record<string, (plan: DataPlanDescription) => string | undefined>> = {
  'no-individual-rankings': (plan) =>
    ranksIndividuals(plan) ? 'the plan ranks or compares individual customers or people' : undefined,
};

/** Check a plan against the deterministic side of the agent's presets. */
export function checkDataPlanPresets(plan: DataPlanDescription, presets: readonly string[]): DataPlanVerdict {
  for (const id of presets) {
    const why = PRESET_CONSTRAINTS[id]?.(plan);
    if (why) return { allowed: false, reason: `${why} (boundary "${id}")`, layer: 'preset' };
  }
  return { allowed: true };
}

/** A plan description as one line a model can judge (no values). */
export function dataPlanText(plan: DataPlanDescription): string {
  const parts = [`read tool ${plan.tool}`];
  if (plan.inputIdentifiers.length > 0) parts.push(`naming ${plan.inputIdentifiers.join(', ')}`);
  if (plan.filterFields.length > 0) parts.push(`filtered by ${plan.filterFields.join(', ')}`);
  if (plan.groupBy.length > 0) parts.push(`grouped by ${plan.groupBy.join(', ')}`);
  if (plan.sort.length > 0) parts.push(`sorted by ${plan.sort.map((s) => `${s.field} ${s.dir}`).join(', ')}`);
  if (plan.take !== undefined) parts.push(`keeping the first ${String(plan.take)} rows`);
  return parts.join('; ');
}
