# 0140 — A formula in a generated workbook may only compute over cells of that workbook

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; implemented in #1265 ("safe office formulas")
- **Supersedes:** —

## Context and Problem Statement

`create_xlsx` writes formulas that come from a model-authored descriptor, and a model's input
can carry text someone else wrote: a mail, a ticket, a web page. A workbook that contains a
formula is written with `fullCalcOnLoad`, so Excel, LibreOffice Calc and Google Sheets
recalculate everything when it is opened. A formula that can reach outside the file would do
so under omadia's name on the reader's machine: fetch a URL built from cell values, read a
local file, call a DLL. This record is retroactive. Which formulas may an export contain?

## Decision Drivers

- The export is opened by people who trust it because omadia produced it.
- Three spreadsheet applications read `.xlsx`; the ways out of each of them count.
- A way out nobody has listed yet must still fail closed.
- Exports need arithmetic, lookups and aggregation; they need nothing that leaves the file.

## Considered Options

- **A — Two lexical layers: an allowlist of Excel's own worksheet functions, and a refusal list
  of everything that reaches outside, wherever it appears.**
- **B — A denylist only** of known dangerous functions.
- **C — No formulas**: write computed values only.

## Decision Outcome

Chosen option: **A** (`middleware/packages/harness-plugin-office/src/formulaPolicy.ts`,
`formulaFunctions.ts`, `formulaText.ts`).

- **Layer 1, allowlist.** A formula may only call Excel's worksheet functions by their English
  names from Microsoft's catalogue. Refused: add-in and user-defined functions (`_xll.`,
  `_xludf.`), Excel 4 macro functions, functions only another application has, localised
  names, and any function Excel adds later until someone has reviewed it. Calling a `LET` or
  `LAMBDA` name counts as a call.
- **Layer 2, refusal wherever it appears**, called or passed as a value, and the error names
  it: URL fetchers (`WEBSERVICE`, `IMAGE`, the Google Sheets `IMPORT*` family, `FILTERXML`),
  file readers (`IMPORTTEXT`, `IMPORTCSV`), vendor services (`STOCKHISTORY`, `TRANSLATE`,
  `DETECTLANGUAGE`, `GOOGLEFINANCE`, `GOOGLETRANSLATE`, the `CUBE` functions), `HYPERLINK`,
  `RTD`, `CALL`, `REGISTER`, `REGISTER.ID`, DDE, and external references to other files.
- **Text-to-reference is refused whatever its argument.** `INDIRECT` and
  `__xludf.DUMMYFUNCTION` turn text into a reference while the client calculates; a lexical
  check cannot see into that text. The policy states that taking one of them off the list
  "reopens every check here".
- **The check reads what the application reads.** Text the file would not carry as written is
  refused first (characters exceljs drops or XML cannot hold, the `_xHHHH_` escape). Outside
  quotes only the grammar's own characters are allowed: no tab, line break, invisible or
  look-alike character. String literals are skipped; quoted sheet names are inspected for
  path characters; an unterminated quote fails closed.
- **The renderer refuses, it does not rewrite.** A descriptor with a refused formula produces
  an error, not a workbook with the formula stripped.

### Consequences

- 🟢 **Good:** An export cannot fetch, read or call anything on the reader's machine through a
  formula, including by functions that do not exist yet.
- 🔴 **Bad:** Legitimate formulas are refused: `INDIRECT`, `HYPERLINK`, localised function
  names, any new Excel function before it is reviewed into `formulaFunctions.ts`.
- 🔴 **Bad:** The check is lexical, not a full parser. Its soundness rests on the stated
  preconditions (text-evaluating functions stay refused, restricted character set).
- 🔴 **Bad:** A bare name that is not called is checked against the refused names only; what it
  could still reach is a function the user's own Excel has loaded, which an export cannot
  supply.
- ⚪ **Neutral:** The function catalogue needs maintenance when Microsoft adds functions.

## Pros and Cons of the Options

### A — Allowlist plus refusal list

- 🟢 Unknown ways out fail closed; known ones are named in the error.
- 🔴 Stricter than users of spreadsheets expect.

### B — Denylist only

- 🟢 Fewer false refusals.
- 🔴 Every new function, add-in prefix or other application's function is allowed until listed.

### C — Values only

- 🟢 No formula risk at all.
- 🔴 The export loses live totals and the user's ability to change inputs.

## More Information

- Related: [ADR-0137](0137-generated-files-are-content-addressed-behind-signed-urls.md);
  `docs/security-architecture.md` §5a (formula cells carry no caller-supplied value).
- Tests: `middleware/test/office-formulas.test.ts`, `middleware/test/office-cell-values.test.ts`.
