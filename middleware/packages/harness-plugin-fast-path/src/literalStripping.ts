/**
 * Learned fast path — tool classification and literal stripping.
 *
 * A learned plan is shared by every user of the instance, so before it is
 * stored the user-specific string literals of its tool input (partner names,
 * emails, free-text search terms) are replaced by typed placeholders
 * (`{{text_1}}`, `{{email_1}}`, `{{id_1}}`); the structural values that make
 * the query what it is — model and field names, operators, enum-like values
 * such as `out_invoice`/`posted`, dates, booleans, limits — are kept. The
 * concrete literals live only in memory for the turn that produced them.
 */

/** Read verbs a learnable tool name starts/ends with. */
const READ_PREFIX = /^(query|get|list|search|find|fetch|read|lookup|describe)_/;
const READ_SUFFIX = /_(query|search|list|get|read|lookup)$/;
/** Any of these tokens makes a tool a write tool — never learnable. */
const WRITE_TOKENS: ReadonlySet<string> = new Set([
  'create', 'update', 'delete', 'remove', 'send', 'post', 'write', 'set', 'add', 'insert',
  'upsert', 'patch', 'put', 'cancel', 'approve', 'archive', 'unlink', 'execute', 'run',
  'trigger', 'import', 'sync', 'mail', 'notify', 'pay', 'book',
]);

/** A tool is learnable when its name reads (prefix/suffix verb) and carries
 *  no write verb token. Case-insensitive; tokens split on `_`, `-`, `.`. */
export function isLearnableToolName(name: string): boolean {
  const n = name.toLowerCase();
  if (!READ_PREFIX.test(n) && !READ_SUFFIX.test(n)) return false;
  return !n.split(/[_.-]+/).some((t) => WRITE_TOKENS.has(t));
}

/** `describe`-tools are learnable but return a schema, never rows — not
 *  useful as a fetch, and not the data source of a publish. */
export function isRowTool(name: string): boolean {
  return isLearnableToolName(name) && !/(^|_)describe(_|$)/.test(name.toLowerCase());
}

export type PlaceholderKind = 'text' | 'email' | 'id';

export interface StrippedInput {
  /** the input with every user-specific literal replaced by `{{kind_n}}` */
  template: unknown;
  /** placeholder → the concrete literal (memory-only, never persisted) */
  literals: Map<string, string | number>;
}

const PLACEHOLDER = /\{\{(text|email|id)_\d+\}\}/;
/** True when any string inside `value` is still a `{{kind_n}}` placeholder. */
export function containsPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return PLACEHOLDER.test(value);
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(containsPlaceholder);
  return false;
}

const OPERATORS: ReadonlySet<string> = new Set([
  '=', '!=', '<>', '<', '<=', '>', '>=', '=like', '=ilike', 'like', 'not like', 'ilike',
  'not ilike', 'in', 'not in', 'child_of', 'parent_of', '=?', '&', '|', '!',
]);
const LIKE_OPS: ReadonlySet<string> = new Set(['=like', '=ilike', 'like', 'not like', 'ilike', 'not ilike']);
/** identifiers, dotted paths, enum values: `account.move`, `out_invoice` */
const IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const ORDER_CLAUSE = /^[a-z_][a-z0-9_.]*( (asc|desc))?(\s*,\s*[a-z_][a-z0-9_.]*( (asc|desc))?)*$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const DATE_TOKEN = /^\{today(?:[+-]\d{1,4}d)?\}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** fields whose compared value is a person/party/free text, never an enum */
const PERSONAL_FIELD =
  /(^|[._])(name|display_name|complete_name|email|email_from|phone|mobile|ref|vat|street|street2|zip|city|login|comment|description|note|website|subject|body|title)$/;
/** input keys that carry free text in generic (non-domain) tools */
const FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
  'q', 'query', 'search', 'term', 'text', 'keyword', 'keywords', 'name', 'email', 'contains',
  'filter_text', 'search_term', 'phrase',
]);
const ORDER_KEYS: ReadonlySet<string> = new Set(['order', 'order_by', 'orderby', 'sort']);
const ID_FIELD = /(^|[._])id$|_ids?$/;

function isStructuralString(s: string): boolean {
  return IDENTIFIER.test(s) || OPERATORS.has(s) || ISO_DATE.test(s) || DATE_TOKEN.test(s);
}

/** An Odoo-style domain condition `[field, operator, value]`. */
function isCondition(v: unknown): v is [string, string, unknown] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === 'string' &&
    IDENTIFIER.test(v[0]) &&
    typeof v[1] === 'string' &&
    OPERATORS.has(v[1])
  );
}

class Stripper {
  readonly literals = new Map<string, string | number>();
  private readonly byLiteral = new Map<string, string>();
  private readonly counters: Record<PlaceholderKind, number> = { text: 0, email: 0, id: 0 };

  placeholder(literal: string | number, kind: PlaceholderKind): string {
    const key = `${kind}:${String(literal)}`;
    const known = this.byLiteral.get(key);
    if (known !== undefined) return known;
    this.counters[kind] += 1;
    const ph = `{{${kind}_${this.counters[kind]}}}`;
    this.byLiteral.set(key, ph);
    this.literals.set(ph, literal);
    return ph;
  }

  private stringValue(s: string, force: boolean): string {
    if (EMAIL.test(s.trim())) return this.placeholder(s, 'email');
    if (!force && isStructuralString(s)) return s;
    if (ISO_DATE.test(s) || DATE_TOKEN.test(s)) return s;
    return this.placeholder(s, 'text');
  }

  /** The compared value of a domain condition on `field` with `op`. */
  private conditionValue(field: string, op: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.conditionValue(field, op, v));
    if (typeof value === 'number') {
      return ID_FIELD.test(field) && Number.isInteger(value) ? this.placeholder(value, 'id') : value;
    }
    if (typeof value !== 'string') return value; // booleans, null, false
    const free = LIKE_OPS.has(op) || PERSONAL_FIELD.test(field);
    if (!free && /^[a-z][a-z0-9_]{0,39}$/.test(value)) return value; // enum-like
    return this.stringValue(value, true);
  }

  walk(value: unknown, key?: string): unknown {
    if (isCondition(value)) {
      const [field, op, v] = value;
      return [field, op, this.conditionValue(field, op, v)];
    }
    if (Array.isArray(value)) return value.map((v) => this.walk(v, key));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.walk(v, k)]),
      );
    }
    if (typeof value === 'string') {
      const k = key?.toLowerCase();
      if (k !== undefined && ORDER_KEYS.has(k) && ORDER_CLAUSE.test(value)) return value;
      return this.stringValue(value, k !== undefined && FREE_TEXT_KEYS.has(k));
    }
    return value;
  }
}

/** Replace the user-specific literals of a tool input by typed placeholders.
 *  Returns a deep copy; the input is never mutated. */
export function stripLiterals(input: unknown): StrippedInput {
  const s = new Stripper();
  const template = s.walk(input);
  return { template, literals: s.literals };
}

/**
 * The STRUCTURAL shape of a stripped template — what "the same plan" means
 * for activation: every placeholder collapses to its kind, every date (or
 * `{today}` token) to `<date>`, numbers compared in a domain condition to
 * `<num>`; models, fields, operators, enum values and limits stay. So
 * "Rechnungen im Januar" and "… im Februar" are one plan.
 */
export function templateShape(template: unknown): unknown {
  if (isCondition(template)) {
    const [field, op, v] = template;
    const shapeValue = (x: unknown): unknown =>
      Array.isArray(x) ? x.map(shapeValue) : typeof x === 'number' ? '<num>' : templateShape(x);
    return [field, op, shapeValue(v)];
  }
  if (Array.isArray(template)) return template.map(templateShape);
  if (typeof template === 'object' && template !== null) {
    return Object.fromEntries(
      Object.entries(template as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, templateShape(v)]),
    );
  }
  if (typeof template === 'string') {
    const ph = /^\{\{(text|email|id)_\d+\}\}$/.exec(template);
    if (ph) return `<${ph[1]}>`;
    if (ISO_DATE.test(template) || DATE_TOKEN.test(template)) return '<date>';
  }
  return template;
}

/** Lowercase, punctuation stripped, whitespace collapsed. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@.-]+/gu, ' ')
    .replace(/(^|\s)[.-]+|[.-]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const LONG_NUMBER = /\b\d{5,}\b/g;

/**
 * The stored intent example: the normalised question with the turn's own
 * literals (as they appear in the question) replaced by their placeholders,
 * plus any email and long digit run (phone, customer number) — the same
 * privacy rule as the tool input.
 */
export function stripQuestion(text: string, literals: ReadonlyMap<string, string | number>): string {
  let q = normalizeQuestion(text);
  const byLength = [...literals.entries()]
    .map(([ph, lit]) => [ph, normalizeQuestion(String(lit))] as const)
    .filter(([, lit]) => lit.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [ph, lit] of byLength) {
    const escaped = lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    q = q.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'), ph);
  }
  return q.replace(EMAIL_IN_TEXT, '{{email}}').replace(LONG_NUMBER, '{{number}}');
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'und', 'oder', 'die', 'der', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'mit', 'von', 'für',
  'auf', 'aus', 'bei', 'the', 'and', 'for', 'with', 'from', 'all', 'alle', 'zeige', 'zeig',
  'show', 'list', 'mir', 'bitte', 'please', 'me', 'wie', 'was', 'what', 'welche', 'which',
]);

/** Content tokens of a (normalised) question for overlap scoring. */
export function questionTokens(text: string): Set<string> {
  return new Set(
    normalizeQuestion(text)
      .split(' ')
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !t.startsWith('{{')),
  );
}

/** Jaccard overlap of two token sets (0 when either is empty). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}
