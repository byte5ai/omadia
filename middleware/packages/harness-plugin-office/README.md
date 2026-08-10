# Headless Office (`@omadia/plugin-office`)

Deterministic `.xlsx` / `.docx` generation from JSON descriptors, persisted to
Tigris under a content-addressed key and delivered to channels via signed
`/documents` URLs. Mirrors the `@omadia/diagrams` artifact pipeline: bytes live
in object storage, never in the LLM context; the tool returns a compact URL +
metadata.

## Tools & capability

| Surface | What it does |
|---|---|
| `create_xlsx` (native tool) | Descriptor → workbook with typed columns, number formats, cross-sheet + per-row formulas. |
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
`docxRenderer.ts` render descriptors to bytes, `officeService.ts` stores + signs,
`provenance.ts` holds the static provenance constants, `signing.ts` the
HMAC-signed `/documents` URLs.

## Tests

Central suite: `middleware/test/office.test.ts` (and `office-dataset.test.ts`).
Provenance is verified by reading the properties back out of the produced file
(ExcelJS load for `.xlsx`, `yauzl` unzip of `docProps/*.xml` for `.docx`), not by
trusting the renderer input.
