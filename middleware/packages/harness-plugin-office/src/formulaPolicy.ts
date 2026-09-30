import { EXCEL_FUNCTIONS } from './formulaFunctions.js';
import { OfficeUnsafeFormulaError } from './types.js';

/**
 * Formula policy: a formula in a generated workbook may only compute over
 * cells of that workbook.
 *
 * Formulas come from model-authored descriptors, and a model's input can carry
 * text someone else wrote (a mail, a ticket, a web page). The workbook asks the
 * opening application to recalculate everything on load, so a formula that can
 * reach outside the file would do so, under omadia's name, as soon as someone
 * opens the export or refreshes its data. Excel, LibreOffice Calc and Google
 * Sheets all recalculate an .xlsx, so the ways out of each of them count.
 *
 * Two layers, so that a way out nobody has listed still fails closed:
 *
 * 1. A formula may only call Excel's own worksheet functions by their English
 *    names (`formulaFunctions.ts`, Microsoft's catalogue), less the refused ones
 *    below. Anything else is refused: add-in and user-defined functions
 *    (`_xll.`, `_xludf.`), Excel 4 macro functions such as EVALUATE, functions
 *    only another application has, localised names such as SUMMEWENNS, and any
 *    function Excel adds later until someone has reviewed it. A function passed
 *    as a value in the file format's spelling (`GROUPBY(…, _xleta.SUM)`)
 *    counts as a call. So does calling a LET or LAMBDA name (`f(A1)`): the
 *    check cannot tell it apart from an add-in function of the same name.
 *    A bare name that is not called (a LET or LAMBDA name, or a function
 *    passed as a value without `_xleta.`) is checked against the refused
 *    names only. What such a name could still reach is a function the user's
 *    own Excel has loaded (a VBA macro or add-in passed by a guessed name),
 *    and an export cannot supply one.
 * 2. Names that reach outside are refused wherever they appear, called or
 *    passed as a value (`LET(f, WEBSERVICE, …)`), and the error names them:
 *    - WEBSERVICE and IMAGE, and Google Sheets' IMPORTDATA, IMPORTXML,
 *      IMPORTHTML, IMPORTFEED and IMPORTRANGE, fetch a URL; built from cell
 *      values, that URL hands the sheet's data to whoever runs the server.
 *      FILTERXML fetches nothing itself, but it exists to unpack what
 *      WEBSERVICE fetched and runs the client's XML parser over formula text.
 *    - IMPORTTEXT and IMPORTCSV read a local file, a UNC path or a URL.
 *    - STOCKHISTORY, TRANSLATE and DETECTLANGUAGE, and Google Sheets'
 *      GOOGLEFINANCE and GOOGLETRANSLATE, send cell data to the vendor's
 *      service, and the CUBE functions query a server through a data
 *      connection. None of them takes an address, but each one carries data
 *      out of the file.
 *    - HYPERLINK turns cell data into a link a user may click.
 *    - RTD, CALL, REGISTER and REGISTER.ID talk to COM servers and DLLs.
 *    - DDE asks the client to talk to another program, as a reference
 *      (`app|topic!item`, e.g. `cmd|' /C calc'!A0`) and as LibreOffice's DDE
 *      function.
 *    - External references (`[1]Sheet!A1`, `[book.xlsx]Sheet!A1`,
 *      `'C:\dir\[book.xlsx]Sheet'!A1`, `\\host\share\book.xlsx!Name`) make the
 *      client open another file, over the network for UNC and URL paths.
 *    - INDIRECT and Google Sheets' `__xludf.DUMMYFUNCTION` turn text into a
 *      reference or a formula while the client calculates. That text can spell
 *      any of the above, a formula can assemble it from cell values
 *      (`INDIRECT(A1)`), and a lexical check cannot see into it, so both are
 *      refused whatever their argument.
 * An export needs none of these, so the renderer refuses them rather than
 * writing them.
 *
 * The check is lexical. String literals are skipped: `"a|b"` or `"HYPERLINK"`
 * inside double quotes is text, not syntax. That holds only while the functions
 * that evaluate text (INDIRECT, DUMMYFUNCTION) stay refused, so taking one off
 * the list reopens every check here. Quoted sheet names are skipped for the
 * function and DDE checks but inspected for path characters, because Excel
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
  'IMPORTTEXT',
  'IMPORTCSV',
  'STOCKHISTORY',
  'TRANSLATE',
  'DETECTLANGUAGE',
  'GOOGLEFINANCE',
  'GOOGLETRANSLATE',
  'CUBEKPIMEMBER',
  'CUBEMEMBER',
  'CUBEMEMBERPROPERTY',
  'CUBERANKEDMEMBER',
  'CUBESET',
  'CUBESETCOUNT',
  'CUBEVALUE',
  'HYPERLINK',
  'RTD',
  'CALL',
  'REGISTER',
  'REGISTER.ID',
  'DDE',
];

/** Functions that turn text into a reference or a formula at calculation time. */
const TEXT_EVALUATING_FUNCTIONS = ['INDIRECT', 'DUMMYFUNCTION'];

/** What a formula may call: Excel's catalogue without the refused names. */
const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set(
  EXCEL_FUNCTIONS.filter(
    (name) => !EXTERNAL_FUNCTIONS.includes(name) && !TEXT_EVALUATING_FUNCTIONS.includes(name),
  ),
);

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

/** A name as the formula grammar reads one: a letter or `_`, then letters,
 *  digits, `_` and `.` (`STDEV.S`, `_xlfn.XLOOKUP`, `_xlpm.x`). Non-ASCII
 *  letters, combining marks and invisible format characters count as part of
 *  the name, so a localised or disguised name is read whole. A match never
 *  starts inside a longer name or right after a digit (`1E3`). */
const NAME_TOKEN = /(?<![\p{L}\p{M}\p{N}\p{Cf}_.])[\p{L}_][\p{L}\p{M}\p{N}\p{Cf}_.]*/gu;

/** Whitespace, then `(`: the name before it is called. */
const OPENS_CALL = /\s*\(/y;

/** File-format prefixes that do not change which function a name means:
 *  `_xlfn.` (newer than the file format), `_xlws.` (worksheet-only) and
 *  `_xleta.` (a function passed as a value). */
const NEUTRAL_PREFIXES = /^(?:_xlfn\.|_xlws\.|_xleta\.)+/i;
const PASSED_AS_VALUE = /^(?:_xlfn\.|_xlws\.)*_xleta\./i;

/** `_xll.` (an XLL add-in) and `_xludf.` (a user-defined function) name code
 *  the client has loaded, which nothing here can inspect. */
const ADDIN_OR_UDF = /(?:^|\.)_{1,2}(?:xll|xludf)\./i;

/** Upper-case ASCII letters only, so a non-ASCII look-alike (`ſum`) never
 *  folds onto an allowed name. */
function asciiUpperCase(name: string): string {
  return name.replace(/[a-z]+/g, (letters) => letters.toUpperCase());
}

/** Why a name in `code` is not allowed, or undefined when every function the
 *  formula calls or passes as a value is on the allowed list. */
function functionNameReason(code: string): string | undefined {
  for (const match of code.matchAll(NAME_TOKEN)) {
    const name = match[0];
    if (ADDIN_OR_UDF.test(name)) {
      return `it uses ${name}, an add-in or user-defined function, which runs code outside the workbook`;
    }
    OPENS_CALL.lastIndex = match.index + name.length;
    if (!OPENS_CALL.test(code) && !PASSED_AS_VALUE.test(name)) continue;
    if (!ALLOWED_FUNCTIONS.has(asciiUpperCase(name.replace(NEUTRAL_PREFIXES, '')))) {
      return `it calls ${name}, which is not one of the Excel functions an export may use (built-in worksheet functions by their English names, e.g. SUMIFS)`;
    }
  }
  return undefined;
}

/** `[n]Sheet!A1` / `[book.xlsx]Sheet!A1` point at another workbook and
 *  `Table1[Col]` at a table; the renderer creates neither. Excel forbids
 *  brackets in sheet names, so they count inside quotes as well. */
const BRACKETS = /[[\]]/;

/** Path separators, also forbidden in sheet names: inside a quoted reference
 *  they can only belong to the path of another file. Outside quotes `/`
 *  divides, but `\` has no meaning in A1 formula syntax, so an unquoted one can
 *  only be part of a path (`\\host\share\book.xlsx!Name`). */
const PATH_SEPARATORS = /[\\/]/;

/**
 * A computed column's `{row}` becomes the row number, and the renderer checks
 * the template once rather than every row. That is sound only while those
 * digits cannot become part of a function name, so `{row}` may complete a
 * column reference (`A{row}`, `$B${row}`) or stand alone (`{row}:{row}`), and
 * nothing may follow it that continues a name or opens a call.
 */
const ROW_PLACEHOLDER = /\{row\}/g;
const GLUED_BEFORE = /[\p{L}\p{M}\p{N}\p{Cf}_.$]+$/u;
const COLUMN_PREFIX = /^\$?(?:[A-Za-z]{1,3}\$?)?$/;
const CONTINUES_NAME_OR_CALL = /[\p{L}\p{M}\p{N}\p{Cf}_.]|\s*\(/uy;

function rowPlaceholderReason(code: string): string | undefined {
  for (const match of code.matchAll(ROW_PLACEHOLDER)) {
    const before = GLUED_BEFORE.exec(code.slice(0, match.index))?.[0] ?? '';
    CONTINUES_NAME_OR_CALL.lastIndex = match.index + match[0].length;
    if (!COLUMN_PREFIX.test(before) || CONTINUES_NAME_OR_CALL.test(code)) {
      return 'its {row} placeholder is not part of a cell reference; write it after a column letter (A{row}) or on its own';
    }
  }
  return undefined;
}

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

const UNTERMINATED_QUOTE = 'it has an unterminated quote';

function lexedFormulaReason(lexed: LexedFormula): string | undefined {
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
  return functionNameReason(lexed.code);
}

/** Why a formula must not be written, or undefined when it only computes over
 *  cells of this workbook. */
export function externalFormulaReason(formula: string): string | undefined {
  const lexed = lexFormula(formula);
  return lexed ? lexedFormulaReason(lexed) : UNTERMINATED_QUOTE;
}

/** {@link externalFormulaReason} for a computed column's template, which must
 *  also keep its `{row}` placeholder out of names and calls. */
export function computedColumnReason(template: string): string | undefined {
  const lexed = lexFormula(template);
  if (!lexed) return UNTERMINATED_QUOTE;
  return lexedFormulaReason(lexed) ?? rowPlaceholderReason(lexed.code);
}

/** Throw {@link OfficeUnsafeFormulaError} unless the formula stays inside the
 *  workbook. `location` names the cell for the message. */
export function assertFormulaStaysInWorkbook(formula: string, location: string): void {
  const reason = externalFormulaReason(formula);
  if (reason !== undefined) throw new OfficeUnsafeFormulaError(location, reason);
}

/** Throw {@link OfficeUnsafeFormulaError} unless a computed column's template
 *  stays inside the workbook for every row it is written to. */
export function assertComputedColumnStaysInWorkbook(template: string, location: string): void {
  const reason = computedColumnReason(template);
  if (reason !== undefined) throw new OfficeUnsafeFormulaError(location, reason);
}
