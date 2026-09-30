import { OfficeUnsafeFormulaError } from './types.js';

/**
 * Formula policy: a formula in a generated workbook may only compute over
 * cells of that workbook.
 *
 * Formulas come from model-authored descriptors, and a model's input can carry
 * text someone else wrote (a mail, a ticket, a web page). The workbook asks the
 * opening application to recalculate everything on load, so a formula that can
 * reach outside the file would do so, under omadia's name, the moment someone
 * opens the export. Excel, LibreOffice Calc and Google Sheets all recalculate
 * an .xlsx, so the ways out of each of them count:
 *   - WEBSERVICE and IMAGE, and Google Sheets' IMPORTDATA, IMPORTXML,
 *     IMPORTHTML, IMPORTFEED and IMPORTRANGE, fetch a URL; built from cell
 *     values, that URL hands the sheet's data to whoever runs the server.
 *     FILTERXML fetches nothing itself, but it exists to unpack what
 *     WEBSERVICE fetched and runs the client's XML parser over formula text.
 *   - HYPERLINK turns cell data into a link a user may click.
 *   - RTD, CALL, REGISTER and REGISTER.ID talk to COM servers and DLLs.
 *   - DDE asks the client to talk to another program, as a reference
 *     (`app|topic!item`, e.g. `cmd|' /C calc'!A0`) and as LibreOffice's DDE
 *     function.
 *   - External references (`[1]Sheet!A1`, `[book.xlsx]Sheet!A1`,
 *     `'C:\dir\[book.xlsx]Sheet'!A1`, `\\host\share\book.xlsx!Name`) make the
 *     client open another file, over the network for UNC and URL paths.
 *   - INDIRECT and Google Sheets' `__xludf.DUMMYFUNCTION` turn text into a
 *     reference or a formula while the client calculates. That text can spell
 *     any of the above, a formula can assemble it from cell values
 *     (`INDIRECT(A1)`), and a lexical check cannot see into it, so both are
 *     refused whatever their argument.
 * An export needs none of these, so the renderer refuses them rather than
 * writing them.
 *
 * The check is lexical. String literals are skipped: `"a|b"` or `"HYPERLINK"`
 * inside double quotes is text, not syntax. Quoted sheet names are skipped for
 * the function and DDE checks but inspected for path characters, because Excel
 * forbids `\ / [ ]` in sheet names, so a quoted reference that contains one
 * names another file. An unterminated quote fails closed.
 */

/** Functions that reach outside the workbook in at least one client, plus
 *  FILTERXML, which only exists to unpack such a fetch (see above). */
const EXTERNAL_FUNCTIONS = [
  'WEBSERVICE',
  'FILTERXML',
  'IMAGE',
  'IMPORTDATA',
  'IMPORTXML',
  'IMPORTHTML',
  'IMPORTFEED',
  'IMPORTRANGE',
  'HYPERLINK',
  'RTD',
  'CALL',
  'REGISTER',
  'REGISTER.ID',
  'DDE',
];

/** Functions that turn text into a reference or a formula at calculation time. */
const TEXT_EVALUATING_FUNCTIONS = ['INDIRECT', 'DUMMYFUNCTION'];

/**
 * Any use of one of `names` as a token: not glued to a neighbouring identifier
 * character (a `_xlfn.` or `__xludf.` prefix still matches), with or without a
 * following `(` so a function passed as a value (`LET(f, WEBSERVICE, …)`) is
 * caught too. A name directly followed by `!` is a sheet (`Image!A1`), not the
 * function. `RTD` and `DDE` are also column names (columns 12,692 and 2,813);
 * a range such as `RTD:RTD` is refused with them, which costs nothing because
 * a descriptor declares at most 256 columns, so those columns never hold data.
 */
function functionToken(names: readonly string[]): RegExp {
  const alternatives = names.map((name) => name.replaceAll('.', '\\.')).join('|');
  return new RegExp(`(?<![A-Za-z0-9_])(${alternatives})(?![A-Za-z0-9_.])(?!\\s*!)`, 'i');
}

const EXTERNAL_FUNCTION_TOKEN = functionToken(EXTERNAL_FUNCTIONS);
const TEXT_EVALUATING_TOKEN = functionToken(TEXT_EVALUATING_FUNCTIONS);

/** `[n]Sheet!A1` / `[book.xlsx]Sheet!A1` point at another workbook and
 *  `Table1[Col]` at a table; the renderer creates neither. Excel forbids
 *  brackets in sheet names, so they count inside quotes as well. */
const BRACKETS = /[[\]]/;

/** Path separators, also forbidden in sheet names: inside a quoted reference
 *  they can only belong to the path of another file. Outside quotes `/`
 *  divides, but `\` has no meaning in A1 formula syntax, so an unquoted one can
 *  only be part of a path (`\\host\share\book.xlsx!Name`). */
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
  const external = EXTERNAL_FUNCTION_TOKEN.exec(lexed.code)?.[1];
  if (external !== undefined) {
    return `it uses ${external.toUpperCase()}, which reaches outside the workbook`;
  }
  const textEvaluating = TEXT_EVALUATING_TOKEN.exec(lexed.code)?.[1];
  if (textEvaluating !== undefined) {
    return `it uses ${textEvaluating.toUpperCase()}, which turns text into a reference or formula that cannot be checked; write references directly`;
  }
  if (lexed.code.includes('|')) {
    return 'it contains a DDE reference (`|`), which starts another program';
  }
  if (BRACKETS.test(lexed.code) || lexed.quotedNames.some((name) => BRACKETS.test(name))) {
    return 'it uses a bracketed reference (another workbook or a table)';
  }
  if (lexed.code.includes('\\') || lexed.quotedNames.some((name) => PATH_SEPARATORS.test(name))) {
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
