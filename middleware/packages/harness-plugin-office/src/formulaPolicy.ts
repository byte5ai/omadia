import { OfficeUnsafeFormulaError } from './types.js';

/**
 * Formula policy: a formula in a generated workbook may only compute over
 * cells of that workbook.
 *
 * Formulas come from model-authored descriptors, and a model's input can carry
 * text someone else wrote (a mail, a ticket, a web page). The workbook asks the
 * opening application to recalculate everything on load, so a formula that can
 * reach outside the file would do so, under omadia's name, the moment someone
 * opens the export:
 *   - WEBSERVICE and IMAGE fetch a URL; built from cell values, that URL hands
 *     the sheet's data to whoever runs the server.
 *   - HYPERLINK turns cell data into a link a user may click.
 *   - RTD, CALL and REGISTER.ID talk to COM servers and DLLs.
 *   - DDE (`app|topic!item`, e.g. `cmd|' /C calc'!A0`) asks the client to start
 *     another program.
 *   - External references (`[1]Sheet!A1`, `'C:\dir\[book.xlsx]Sheet'!A1`,
 *     `'\\host\share\book.xlsx'!Name`) make the client open another file, over
 *     the network for UNC and URL paths.
 * An export needs none of these, so the renderer refuses them rather than
 * writing them.
 *
 * The check is lexical. String literals are skipped: `"a|b"` or `"HYPERLINK"`
 * inside double quotes is text, not syntax. Quoted sheet names are skipped for
 * the function and DDE checks but inspected for path characters, because Excel
 * forbids `\ / [ ]` in sheet names, so a quoted reference that contains one
 * names another file. An unterminated quote fails closed.
 */

/** Functions whose evaluation leaves the workbook. */
const EXTERNAL_FUNCTIONS = ['WEBSERVICE', 'IMAGE', 'HYPERLINK', 'RTD', 'CALL', 'REGISTER.ID'];

/**
 * Any use of one of those names as a token: not glued to a neighbouring
 * identifier character (a `_xlfn.` prefix still matches), with or without a
 * following `(` so a function passed as a value (`LET(f, WEBSERVICE, …)`) is
 * caught too. A name directly followed by `!` is a sheet (`Image!A1`), not the
 * function. `RTD` is also a column name (column 12,692); a range such as
 * `RTD:RTD` is refused with it, which costs nothing because a descriptor
 * declares at most 256 columns, so that column never holds data.
 */
const EXTERNAL_FUNCTION_TOKEN = new RegExp(
  `(?<![A-Za-z0-9_])(${EXTERNAL_FUNCTIONS.map((name) => name.replace('.', '\\.')).join('|')})(?![A-Za-z0-9_.])(?!\\s*!)`,
  'i',
);

/** `[n]Sheet!A1` / `[book.xlsx]Sheet!A1` point at another workbook and
 *  `Table1[Col]` at a table; the renderer creates neither. Excel forbids
 *  brackets in sheet names, so they count inside quotes as well. */
const BRACKETS = /[[\]]/;

/** Path separators, also forbidden in sheet names: inside a quoted reference
 *  they can only belong to the path of another file. */
const PATH_SEPARATORS = /[\\/]/;

interface LexedFormula {
  /** The formula with string literals and quoted sheet names blanked out. */
  readonly code: string;
  /** Contents of the single-quoted (sheet-name) segments. */
  readonly quotedNames: readonly string[];
}

/** Separate a formula's syntax from its quoted parts. Both quote kinds escape
 *  themselves by doubling (`""` in a string, `''` in a sheet name). Returns
 *  undefined when a quote is never closed. */
function lexFormula(formula: string): LexedFormula | undefined {
  let code = '';
  const quotedNames: string[] = [];
  let i = 0;
  while (i < formula.length) {
    const ch = formula.charAt(i);
    if (ch !== '"' && ch !== "'") {
      code += ch;
      i += 1;
      continue;
    }
    let content = '';
    let j = i + 1;
    for (;;) {
      if (j >= formula.length) return undefined;
      const next = formula.charAt(j);
      if (next === ch && formula.charAt(j + 1) === ch) {
        content += ch;
        j += 2;
      } else if (next === ch) {
        break;
      } else {
        content += next;
        j += 1;
      }
    }
    if (ch === "'") quotedNames.push(content);
    code += ' ';
    i = j + 1;
  }
  return { code, quotedNames };
}

/** Why a formula must not be written, or undefined when it only computes over
 *  cells of this workbook. */
export function externalFormulaReason(formula: string): string | undefined {
  const lexed = lexFormula(formula);
  if (!lexed) return 'it has an unterminated quote';
  const fn = EXTERNAL_FUNCTION_TOKEN.exec(lexed.code)?.[1];
  if (fn !== undefined) {
    return `it uses ${fn.toUpperCase()}, which reaches outside the workbook`;
  }
  if (lexed.code.includes('|')) {
    return 'it contains a DDE reference (`|`), which starts another program';
  }
  if (BRACKETS.test(lexed.code) || lexed.quotedNames.some((name) => BRACKETS.test(name))) {
    return 'it uses a bracketed reference (another workbook or a table)';
  }
  if (lexed.quotedNames.some((name) => PATH_SEPARATORS.test(name))) {
    return 'it references another file by its path';
  }
  return undefined;
}

/** Throw {@link OfficeUnsafeFormulaError} unless the formula stays inside the
 *  workbook. `location` names the cell (or computed column) for the message. */
export function assertFormulaStaysInWorkbook(formula: string, location: string): void {
  const reason = externalFormulaReason(formula);
  if (reason !== undefined) throw new OfficeUnsafeFormulaError(location, reason);
}
