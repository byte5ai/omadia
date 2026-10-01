# Headless Office (`@omadia/plugin-office`)

Deterministic `.xlsx` / `.docx` generation from JSON descriptors, persisted to
Tigris under a content-addressed key and delivered to channels via signed
`/documents` URLs. Mirrors the `@omadia/diagrams` artifact pipeline: bytes live
in object storage, never in the LLM context; the tool returns a compact URL +
metadata.

## Tools & capability

| Surface | What it does |
|---|---|
| `create_xlsx` (native tool) | Descriptor → workbook with typed columns, number formats, cross-sheet + per-row formulas. Formulas are stored without cached values and computed by the application that opens the file (see [Formulas](#formulas)). |
| `create_docx` (native tool) | Descriptor → document with headings, paragraphs, bullets, tables. |

## Determinism

Both pipelines are **content-addressed**: `officeService` keys the storage
object on the sha256 of the file bytes and skips the write on a cache hit
(`store.exists(key)`). Rendering the same descriptor therefore has to produce
byte-identical output, or the cache never hits and every re-render re-stores.

Neither renderer library cooperates on its own: exceljs stamps each **zip entry
mtime** from the wall clock, and docx v9 additionally stamps
`dcterms:created/modified` in `core.xml` — with no API to pin either. `renderXlsx`
and `renderDocx` therefore run the produced buffer through `ooxmlNormalize`
(`src/ooxmlNormalize.ts`), which re-emits the zip with every entry mtime pinned
to `DETERMINISTIC_EPOCH` and rewrites the docx `dcterms` timestamps to the same
epoch. After that pass the bytes depend only on the descriptor: two renders taken
years apart are identical, so the cache genuinely hits. The determinism tests
prove this by **advancing** a mocked clock between two renders and asserting the
bytes are unchanged; a cache-path test asserts the second render is a cache hit
and is stored exactly once. Nothing turn-scoped ever enters a file.

## Formulas

A formula cell (`{ "formula": "SUMIFS(…)" }`) and a computed column
(`columns[].formula` with its `{row}` placeholder) are written verbatim into the
cell's `<f>` element, cross-sheet references included. The server has no
spreadsheet engine. exceljs serialises formulas and computes nothing, and the
package ships no evaluator: HyperFormula is GPL/commercial and therefore out,
and server-side evaluation with an MIT engine is a roadmap item
(`docs/middleware-agent-handoff.md` §13).

- **No cached values.** A formula cell is stored as `<f>` without `<v>`. The
  input schema has no `result` field (one that is sent anyway is stripped), and
  the renderer drops it again before exceljs sees the cell, so a number the
  model supplies can never show up as a formula's value.
- **Only plain values reach exceljs.** exceljs decides what a cell is from the
  shape of the value: any object with a truthy `formula` or `sharedFormula` is
  a formula, with its `result` as the cached value, and `{ text, hyperlink }`
  is a link. `renderXlsx` is exported and does not rely on the input schema,
  so it takes only text, numbers, booleans, `null` and `{ formula }` with a
  non-empty formula string as a cell value, reading only a row's own keys.
  Any other cell value, a column header that is not text and a computed-column
  formula that is not text fail with `OfficeRenderError` before exceljs sees
  them.
- **Recalculation on open.** A workbook that holds at least one formula sets
  `<calcPr fullCalcOnLoad="1"/>`. Excel recalculates it on open and therefore
  asks to save changes on close. Plain data exports keep a clean `calcPr`.
- **English grammar.** `<f>` holds the file format's syntax in every locale:
  English function names (`SUMIFS`) and `,` between arguments. A German name
  such as `SUMMEWENNS` shows up as `#NAME?`. TEXT date codes such as `"YYYY"`
  are read in the opening application's language, which is why the prompt
  builds month keys from `YEAR`/`MONTH`.
- **Dataset rows stay data.** Rows behind a `datasetId` pass through
  `normalizeCell` (`officeTool.ts`), which JSON-stringifies every object and
  array, so a system of record can never contribute a formula or a cached value.

An empty cell is the intended result wherever nothing calculates. What formula
cells show depends on where the file is opened:

| Opened in | Formula cells show |
|---|---|
| Excel with editing enabled | computed values |
| Excel Protected View (typical for a file downloaded from Teams or a browser) | possibly empty until *Enable Editing* |
| LibreOffice Calc | whatever *Tools ▸ Options ▸ LibreOffice Calc ▸ Formula ▸ Recalculation on File Load* says; set it to *Always recalculate* if cells stay empty |
| Quick Look, Teams and Outlook previews | empty, because previews do not calculate |
| openpyxl with `data_only=True`, pandas | `None` / `NaN` |
| omadia's dataset upload (`datasetImportXlsx.ts`) | empty strings, unless the file was saved in Excel first, since the importer reads cached results |

### Formulas stay inside the workbook

Because the file asks to be recalculated, a formula that can reach outside it
would do so as soon as someone opens the export (or refreshes its data), and
Excel, LibreOffice and Google Sheets all recalculate an `.xlsx`. `renderXlsx`
checks every formula it writes in two layers, so that a way out nobody has
listed still fails closed. A value that exceljs would turn into a formula
without that check never gets that far (see *Only plain values reach exceljs*
above).

**Only Excel's own functions.** A formula may call a function only if it is on
Microsoft's list of Excel worksheet functions (`src/formulaFunctions.ts`,
copied from Microsoft's alphabetical catalogue on 2026-09-30) and not refused
below. Names are matched in English, with or without the file format's
`_xlfn.`/`_xlws.` prefixes. Everything else is refused, whatever it does:

- add-in and user-defined functions (`_xll.…`, `_xludf.…`), in any position
- Excel 4 macro functions such as `EVALUATE`, and functions only Google Sheets
  or LibreOffice have
- localised names such as `SUMMEWENNS`, and look-alikes in other scripts
- functions Excel adds later, until someone checks them and adds them to the
  list. `IMPORTTEXT` and `IMPORTCSV` are two such additions.
- a call through a LET or LAMBDA name (`f(A1)`). The check cannot tell it apart
  from an add-in function with the same name.

A function passed as a value in the file format's spelling
(`GROUPBY(…, _xleta.SUM)`) is checked like a call. A bare name that is not
called (a LET name, or `SUM` passed to `GROUPBY` without the prefix) is only
checked against the refused names. What it could still reach is a function the
user's own Excel has loaded, such as a VBA macro, and an export cannot supply
one.

**Known ways out, refused by name.** These are refused wherever they appear,
also when passed as a value (`LET(f, WEBSERVICE, …)`), and the error names
them:

- a function that fetches a URL or unpacks what was fetched: `WEBSERVICE`,
  `FILTERXML`, `IMAGE`, and Google Sheets' `IMPORTDATA`, `IMPORTXML`,
  `IMPORTHTML`, `IMPORTFEED` and `IMPORTRANGE`
- `IMPORTTEXT` and `IMPORTCSV`, which read a local file, a UNC path or a URL
- functions that send cell data to the vendor's service or query a server:
  `STOCKHISTORY`, `TRANSLATE`, `DETECTLANGUAGE`, Google Sheets'
  `GOOGLEFINANCE` and `GOOGLETRANSLATE`, and the `CUBE…` functions
- `HYPERLINK`, and the COM and DLL calls `RTD`, `CALL`, `REGISTER` and
  `REGISTER.ID`
- DDE, as a reference (`app|topic!item`) or as LibreOffice's `DDE` function
- a reference to another file (`[1]Sheet!A1`, `[book.xlsx]Sheet!A1`,
  `'C:\dir\[book.xlsx]Sheet'!A1`, `\\host\share\book.xlsx!Name`)
- `INDIRECT` or `__xludf.DUMMYFUNCTION`, whatever the argument. Both turn text
  into a reference or a formula, and that text can be built from cell values
  where the check cannot see it.

A computed column is checked once, as a template. Its `{row}` placeholder may
only follow a column letter (`A{row}`, `$B${row}`) or stand on its own, so the
row number can never become part of a function name.

It throws `OfficeUnsafeFormulaError`, which names the cell or computed column,
before any byte is written: nothing is stored, and `create_xlsx` returns an
`Error:` the model can act on. The check in `src/formulaPolicy.ts` is lexical.
Text inside a string literal does not count, and an unterminated quote is
refused.

A lexical check only works if it reads what the application reads, so it
starts with the text (`src/formulaText.ts`). A formula is refused if it
contains a character the file would not carry as written (exceljs drops most
control characters on the way into the XML, and XML cannot hold an unpaired
surrogate, U+FFFE or U+FFFF) or `_x` followed by a hexadecimal digit, the file
format's escape for a single character. The input schema refuses the same, so
the model gets the error before any dataset is resolved. Outside quotes a
formula may only use letters, digits, plain spaces and operators, on one line:
tabs, line breaks, other spaces and invisible or look-alike characters are
refused there, while tab and line feed are fine inside quotes. Names are read
as Excel's grammar reads them, so `?` and non-ASCII characters continue a name.

## Provenance metadata (AI Act Art. 50)

Every generated file carries a **static, machine-readable provenance marker** in
its OOXML properties, marking it as AI-generated (#645, epic #642). The values
live in `src/provenance.ts` and are constant by design — a timestamp, turn-id or
model-id would make each file unique and defeat the content-addressed cache, so
turn-scoped provenance goes into the API envelope and audit trail instead (#647),
never into the file.

| Format | Marker | Slot |
|---|---|---|
| `.docx` | `description`, `keywords` **and** structured custom properties (`AIGenerated=true`, `Generator`, `ProvenanceStandard`) | `docProps/core.xml` + `docProps/custom.xml` |
| `.xlsx` | `description`, `keywords`, `category` (core properties only) | `docProps/core.xml` |

**Known limitation — `.xlsx` is coarser than `.docx`.** exceljs offers no
reliable support for user-defined OOXML custom properties, so `.xlsx` carries the
marker in core properties only (including a `category = "AI-generated"`) and does
_not_ get the structured `AIGenerated` flag that `.docx` does. This is a
deliberate, named limitation of the underlying library, not an omission.

## Layout

Standard tool-plugin shape: `src/` → compiled `dist/`. `xlsxRenderer.ts` /
`docxRenderer.ts` render descriptors to bytes, `formulaPolicy.ts` refuses
formulas that reach outside the workbook or call a function outside
`formulaFunctions.ts` (Excel's catalogue), after `formulaText.ts` has refused
formula text the file would not store as written, `officeService.ts` stores + signs,
`provenance.ts` holds the static provenance constants, `signing.ts` the
HMAC-signed `/documents` URLs.

## Release

The version lives in `manifest.yaml` (`identity.version`) **and**
`package.json` — bump both. The Hub ZIP is cut only by
`npm run package -w @omadia/plugin-office` (→
`middleware/scripts/build-plugin-zip.mjs`, output in `<repo>/out/`), from a
clean, committed tree. Publish steps: `docs/creating-plugins.md` §8
("In-tree-Pakete").

## Tests

Central suite: `middleware/test/office.test.ts`, with `office-formulas.test.ts`
(formula storage and the formula policy), `office-cell-values.test.ts` (the
values `renderXlsx` refuses before exceljs sees them) and
`office-dataset.test.ts`.
Provenance is verified by reading the properties back out of the produced file
(ExcelJS load for `.xlsx`, `yauzl` unzip of `docProps/*.xml` for `.docx`), not by
trusting the renderer input. Formula cells are checked the same way: the tests
read `xl/worksheets/sheet1.xml` and `xl/workbook.xml` back out of the workbook to
prove there is no `<v>` next to a formula and that `fullCalcOnLoad` is set.
