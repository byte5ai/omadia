/**
 * ADR-0255 — a SQL grant on the borrowed `graphPool` covers the plugin's own
 * tables, not the kernel's.
 *
 * `permissions.sql` plus an operator grant gives a plugin the shared pool
 * (C7). Before this guard the pool passed every statement through, so a
 * granted plugin could `SELECT` the kernel's graph, memory, user and audit
 * tables past the turn's graph read boundary (ADR-0040, ADR-0044).
 *
 * HOW IT DECIDES
 * --------------
 * The statement text is tokenised, not parsed: comments and string literals
 * are skipped, and every identifier (bare or quoted, each part of a qualified
 * name) is compared with the kernel's relations
 * ({@link KERNEL_SQL_RELATIONS}). One hit refuses the whole statement. That
 * is conservative on purpose: a column that happens to share a kernel table's
 * name is refused too, and the plugin renames its column or quotes nothing
 * away. A false refusal is a bug report; a false pass is a leak.
 *
 * WHAT FAILS CLOSED
 * -----------------
 * Whatever the tokeniser cannot read with certainty is refused:
 *  - an unterminated string, quoted identifier or block comment;
 *  - dollar-quoted text (`$$ … $$`, `$tag$ … $tag$`): a function or `DO`
 *    body is code the tokens do not show;
 *  - `U&"…"` / `U&'…'` escapes, which spell a name without its letters;
 *  - `DO` as a statement and `CREATE [OR REPLACE] FUNCTION | PROCEDURE`,
 *    whose body is a string literal;
 *  - functions that run SQL text or read a relation named by a string
 *    ({@link SQL_TEXT_FUNCTIONS});
 *  - a `plg_…` name outside the plugin's own `plg_<plugin>` namespace (another
 *    plugin's ledger or schema);
 *  - names that change how the tokeniser must read later statements
 *    (`standard_conforming_strings`, `backslash_quote`, `set_config`), that
 *    show row values of any table (`pg_stats`), or that reach the kernel's
 *    notification channels (`LISTEN`, `NOTIFY`, `pg_notify`)
 *    ({@link REFUSED_SQL_NAMES});
 *  - a query whose text is not a string, and a submittable (`submit`), which
 *    `pg` hands the raw connection. A config is copied once, so the text the
 *    guard read is the text that runs.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * Plugins run in the kernel's process. The guard keeps a plugin's SQL on the
 * borrowed pool to its own tables; it does not contain a hostile upload that
 * reads the connection string from its environment and opens a pool of its
 * own (ADR-0255, residual).
 */
import {
  KERNEL_SQL_RELATIONS,
  PLUGIN_OWNED_KERNEL_RELATIONS,
  REFUSED_SQL_NAMES,
  SQL_TEXT_FUNCTIONS,
} from './kernelSqlRelations.js';
import { PLUGIN_LEDGER_NAMESPACE, sanitizedPluginPrefix } from './pluginSqlGrants.js';

/** Thrown when a plugin's statement on the borrowed pool names what is not its own. */
export class SqlTableRefusedError extends Error {
  public readonly pluginId: string;
  public readonly reason: string;

  constructor(pluginId: string, reason: string) {
    super(
      `plugin '${pluginId}' may not run this statement through graphPool: ${reason}. ` +
        "A SQL grant covers the plugin's own tables, not the kernel's (ADR-0255).",
    );
    this.name = 'SqlTableRefusedError';
    this.pluginId = pluginId;
    this.reason = reason;
  }
}

type Token = { readonly kind: 'ident'; readonly value: string } | { readonly kind: 'semicolon' } | { readonly kind: 'paren' };

/** Characters that start or continue an unquoted identifier (Postgres rules). */
const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;

/** Index after the closing quote of a quoted run starting at `start`, where a
 *  doubled quote is an escaped quote. `backslash`: `E'…'`, where `\` escapes. */
function skipQuoted(sql: string, start: number, quote: string, backslash: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (backslash && ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw new Error(`unterminated ${quote === '"' ? 'quoted identifier' : 'string literal'}`);
}

/** Index after a (nested, as in Postgres) block comment starting at `start`. */
function skipBlockComment(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql.startsWith('/*', i)) {
      depth += 1;
      i += 2;
    } else if (sql.startsWith('*/', i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  throw new Error('unterminated block comment');
}

/** The identifiers, statement ends and opening parentheses of `sql`, or a
 *  thrown `Error` naming what could not be read. */
export function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', i)) {
      i = skipBlockComment(sql, i);
    } else if (ch === "'") {
      i = skipQuoted(sql, i, "'", false);
    } else if (ch === '"') {
      const end = skipQuoted(sql, i, '"', false);
      tokens.push({ kind: 'ident', value: sql.slice(i + 1, end - 1).replace(/""/g, '"').toLowerCase() });
      i = end;
    } else if (ch === '$') {
      const param = /^\$\d+/.exec(sql.slice(i));
      if (!param) throw new Error('dollar-quoted text is not checked');
      i += param[0].length;
    } else if (IDENT_START.test(ch)) {
      let end = i + 1;
      while (end < sql.length && IDENT_PART.test(sql[end]!)) end += 1;
      const word = sql.slice(i, end);
      const next = sql[end];
      if (/^u$/i.test(word) && next === '&') throw new Error('U& escapes are not checked');
      if (/^e$/i.test(word) && next === "'") {
        i = skipQuoted(sql, end, "'", true);
        continue;
      }
      // B'…', X'…', N'…': a literal with a one-letter prefix, not a name.
      if (/^[bxn]$/i.test(word) && next === "'") {
        i = skipQuoted(sql, end, "'", false);
        continue;
      }
      if (word.includes('$')) throw new Error('dollar-quoted text is not checked');
      tokens.push({ kind: 'ident', value: word.toLowerCase() });
      i = end;
    } else {
      if (ch === ';') tokens.push({ kind: 'semicolon' });
      else if (ch === '(') tokens.push({ kind: 'paren' });
      i += 1;
    }
  }
  return tokens;
}

/** Why `sql` is refused for `pluginId`, or `undefined` if it may run. */
export function sqlRefusalReason(pluginId: string, sql: string): string | undefined {
  let tokens: Token[];
  try {
    tokens = tokenizeSql(sql);
  } catch (err) {
    return (err as Error).message;
  }
  const owned = PLUGIN_OWNED_KERNEL_RELATIONS[pluginId];
  const ownNamespace = `${PLUGIN_LEDGER_NAMESPACE}${sanitizedPluginPrefix(pluginId)}`;
  let statementStart = true;
  let previous: string | undefined;
  let beforePrevious: string | undefined;
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== 'ident') {
      statementStart = token.kind === 'semicolon';
      previous = undefined;
      beforePrevious = undefined;
      continue;
    }
    const word = token.value;
    if (statementStart && word === 'do') return "a DO block's body is not checked";
    if (statementStart && (word === 'listen' || word === 'notify')) return `${word.toUpperCase()} reaches the kernel's channels`;
    if (REFUSED_SQL_NAMES.has(word)) return `'${word}' is not available through graphPool`;
    if ((word === 'function' || word === 'procedure') && (previous === 'create' || (previous === 'replace' && beforePrevious === 'or'))) {
      return `a ${word} body is not checked`;
    }
    if (SQL_TEXT_FUNCTIONS.has(word) && tokens[index + 1]?.kind === 'paren') {
      return `${word}() runs SQL text the guard cannot check`;
    }
    if (KERNEL_SQL_RELATIONS.has(word) && !owned?.has(word)) {
      return `'${word}' is a kernel relation`;
    }
    if (word.startsWith(PLUGIN_LEDGER_NAMESPACE) && word !== ownNamespace && !word.startsWith(`${ownNamespace}_`)) {
      return `'${word}' lies in another plugin's namespace`;
    }
    statementStart = false;
    beforePrevious = previous;
    previous = word;
  }
  return undefined;
}

/** The fields of a `pg` query config the guard forwards. Anything else (a
 *  `submit` hook, a getter that changes its answer) never reaches `pg`. */
interface PlainQueryConfig {
  readonly text: string;
  readonly values?: unknown;
  readonly name?: unknown;
  readonly rowMode?: unknown;
  readonly types?: unknown;
}

/**
 * The first argument of a `query(...)` call as the guard checks it and `pg`
 * runs it: a string, or a fresh plain config whose `text` was read once. A
 * submittable (`submit`) is refused: `pg` hands it the raw wire connection.
 */
function plainStatement(pluginId: string, arg: unknown): string | PlainQueryConfig {
  if (typeof arg === 'string') return arg;
  if (typeof arg !== 'object' || arg === null) {
    throw new SqlTableRefusedError(pluginId, 'the statement text is not readable');
  }
  const config = arg as Record<string, unknown>;
  if (typeof config['submit'] === 'function') {
    throw new SqlTableRefusedError(pluginId, 'a submittable query reaches the connection directly');
  }
  const text = config['text'];
  if (typeof text !== 'string') throw new SqlTableRefusedError(pluginId, 'the statement text is not readable');
  return Object.freeze({
    text,
    values: config['values'],
    name: config['name'],
    rowMode: config['rowMode'],
    types: config['types'],
  });
}

/**
 * The statement to hand to `pg` in place of the plugin's first `query`
 * argument. Throws {@link SqlTableRefusedError} unless it may run for
 * `pluginId`. The checked text is the text that runs: a config is copied.
 */
export function checkedPluginStatement(pluginId: string, queryArg: unknown): string | PlainQueryConfig {
  const statement = plainStatement(pluginId, queryArg);
  const text = typeof statement === 'string' ? statement : statement.text;
  const reason = sqlRefusalReason(pluginId, text);
  if (reason !== undefined) throw new SqlTableRefusedError(pluginId, reason);
  return statement;
}

/** {@link checkedPluginStatement} for callers that only need the verdict. */
export function assertPluginStatement(pluginId: string, queryArg: unknown): void {
  checkedPluginStatement(pluginId, queryArg);
}
