import type { ChatTurnInput } from '@omadia/channel-sdk';
import {
  catalogColumnLabel,
  catalogDetailFields,
  CURRENCY_ATTR,
  isCatalogBooleanField,
  ODOO_QUERY_MAX_LIMIT,
  type RefreshSource,
} from '@omadia/fast-path';

/**
 * LLM-free row details ("Details anzeigen" on a canvas table row).
 *
 * The client sends `action: { type: 'row_details' }` with the row's
 * TargetRef. The lookup is fully deterministic: the table's persisted refresh
 * recipe names the tool and the Odoo model, the row key IS the record id. So
 * the orchestrator queries exactly that record with the catalog's detail
 * fields and renders a heading + 2-column key/value table — no composer, no
 * agent, no model sees a value. These are the pure building blocks; the
 * gating (recipe, offered tools, privacy) lives in plugin.ts.
 */

export const ROW_DETAILS_ACTION = 'row_details';
/** The one tool row details run for (an id-equality capable read). */
export const ROW_DETAILS_TOOL = 'odoo_query';

/** Container ids of the rendered detail view. */
const VIEW_ID = 'row-details';

type Lang = 'de' | 'en';

const TEXT: Readonly<Record<Lang, {
  title: string;
  field: string;
  value: string;
  yes: string;
  no: string;
  answer: (name: string) => string;
  answerAnon: string;
  ask: string;
}>> = {
  de: {
    title: 'Details',
    field: 'Feld',
    value: 'Wert',
    yes: 'Ja',
    no: 'Nein',
    answer: (name) => `Details zu ${name}.`,
    answerAnon: 'Details zum Datensatz.',
    ask: 'Details anzeigen',
  },
  en: {
    title: 'Details',
    field: 'Field',
    value: 'Value',
    yes: 'Yes',
    no: 'No',
    answer: (name) => `Details for ${name}.`,
    answerAnon: 'Record details.',
    ask: 'Show details',
  },
};

const NUMBER_LOCALE: Readonly<Record<Lang, string>> = { de: 'de-DE', en: 'en-US' };

/** Money attributes (Odoo naming) — rendered with the record's currency. */
const MONETARY_ATTR = /amount|price|balance|debit|credit|residual|subtotal/i;
const EMPTY = '—';

/** True for the structured "Details anzeigen" action. */
export function isRowDetailsAction(input: ChatTurnInput): boolean {
  return input.action?.type === ROW_DETAILS_ACTION;
}

/** UI language: `action.payload.locale` (BCP-47) when given, else German
 *  (the canvas client's language). */
export function rowDetailsLanguage(input: ChatTurnInput): Lang {
  const payload = input.action?.payload;
  const locale =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)['locale'] : undefined;
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? 'en' : 'de';
}

/** A row key as an Odoo record id: a positive safe integer, written
 *  canonically (no sign, no leading zero, no fraction), else undefined. */
export function parseRecordId(key: string): number | undefined {
  if (!/^[1-9]\d{0,15}$/.test(key)) return undefined;
  const id = Number(key);
  return Number.isSafeInteger(id) ? id : undefined;
}

function recipeFields(recipe: RefreshSource): string[] {
  const input = recipe.input as Record<string, unknown> | null;
  const declared = input?.['fields'];
  const fromInput = Array.isArray(declared) ? declared.filter((f): f is string => typeof f === 'string') : [];
  const fields = fromInput.length > 0 ? fromInput : Object.values(recipe.map).map((attr) => attr.split('.')[0] ?? attr);
  return [...new Set(fields.filter((f) => f.length > 0 && f !== 'id'))];
}

/**
 * The detail query for record `id` of the table filled by `recipe`: same
 * tool, same model, `[["id","=",id]]`, the catalog's detail fields for that
 * model (else the recipe's own fields), the tool's maximum limit. Identity
 * map (attribute → itself) so the shared fetch maps every field. Undefined
 * when the recipe names no model.
 */
export function rowDetailsSource(recipe: RefreshSource, id: number): RefreshSource | undefined {
  const model = (recipe.input as { model?: unknown } | null)?.model;
  if (typeof model !== 'string' || model.length === 0) return undefined;
  const fields = [...(catalogDetailFields(model) ?? recipeFields(recipe))];
  if (fields.length === 0) return undefined;
  return {
    tool: recipe.tool,
    input: { model, domain: [['id', '=', id]], fields, limit: ODOO_QUERY_MAX_LIMIT },
    itemsPath: recipe.itemsPath ?? 'records',
    map: Object.fromEntries(fields.map((f) => [f, f])),
    rowKey: 'id',
  };
}

/** Odoo many2one `[id, "Name"]` → its display name. */
function many2oneName(value: unknown): string | undefined {
  return Array.isArray(value) && value.length === 2 && typeof value[1] === 'string' ? value[1] : undefined;
}

/**
 * One detail value as plain text: many2one → display name, a boolean
 * catalog field → Ja/Nein, Odoo `false`/empty → "—", money → two decimals
 * plus the record's currency, dates and everything else as-is.
 */
export function formatDetailValue(
  model: string,
  attr: string,
  value: unknown,
  record: Readonly<Record<string, unknown>>,
  lang: Lang,
): string {
  if (typeof value === 'boolean' && (value || isCatalogBooleanField(model, attr))) {
    return value ? TEXT[lang].yes : TEXT[lang].no;
  }
  if (value === false || value === null || value === undefined || value === '') return EMPTY;
  const name = many2oneName(value);
  if (name !== undefined) return name;
  if (typeof value === 'number') {
    if (!MONETARY_ATTR.test(attr) || !Number.isFinite(value)) return String(value);
    const amount = new Intl.NumberFormat(NUMBER_LOCALE[lang], {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
    const currency = many2oneName(record[CURRENCY_ATTR]);
    return currency !== undefined ? `${amount} ${currency}` : amount;
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** The record's display name (`name`), else undefined. */
function recordName(record: Readonly<Record<string, unknown>>): string | undefined {
  const name = record['name'];
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined;
}

/** The deterministic detail view: a heading (record name or "Details") and a
 *  2-column key/value table, one row per detail field (rowKey = attribute). */
export function buildRowDetailsTree(opts: {
  model: string;
  record: Readonly<Record<string, unknown>>;
  fields: readonly string[];
  lang: Lang;
}): { tree: Record<string, unknown>; title: string | undefined } {
  const t = TEXT[opts.lang];
  const title = recordName(opts.record);
  const rows = opts.fields.map((attr) => ({
    rowKey: attr,
    cells: {
      field: catalogColumnLabel({ fieldKey: attr, attr, model: opts.model, lang: opts.lang }),
      value: formatDetailValue(opts.model, attr, opts.record[attr], opts.record, opts.lang),
    },
  }));
  return {
    title,
    tree: {
      type: 'container',
      id: 'root',
      layout: 'stack',
      children: [
        { type: 'heading', id: `${VIEW_ID}.title`, content: title ?? t.title, level: 2 },
        {
          type: 'table',
          id: VIEW_ID,
          columns: [
            { fieldKey: 'field', label: t.field },
            { fieldKey: 'value', label: t.value },
          ],
          rows,
        },
      ],
    },
  };
}

/** The templated answer sentence ("Details zu <name>."). */
export function rowDetailsAnswer(title: string | undefined, lang: Lang): string {
  return title !== undefined ? TEXT[lang].answer(title) : TEXT[lang].answerAnon;
}

/** Transcript line for an action turn without user text. */
export function rowDetailsAsk(model: string, id: number, lang: Lang): string {
  return `${TEXT[lang].ask} (${model} ${id})`;
}
