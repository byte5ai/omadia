# 0267 — `query_rows` range filters on date columns compare as dates; encrypted columns stay unfilterable

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** Maintainers (wave 5, W05-06), from #2302 (residual of #2261).
- **Supersedes:** —
- **Refines:** [ADR-0098](0098-uploaded-dataset-cells-encrypted-with-link-keys.md),
  [ADR-0118](0118-graph-nodes-stay-small-bulk-data-in-sidecar-tables.md) (the `query_dataset` DSL).

## Context and Problem Statement

`validateDatasetQueryOptions` (plugin-api) allowed `gt`/`gte`/`lt`/`lte` only on `number`
columns. The reason was technical, not privacy: `date` cells were stored as written, so a range
had no defined order. Since #1845 the import stores every `date` cell as ISO-8601
(`datasetDates.ts`). "Invoices due in April" still failed with `op_type_mismatch`. How should a
date range be compared, which bound spellings are accepted, and which columns may take one?

## Decision Drivers

- Both graph backends (Neon SQL, in-memory) must return the same rows.
- A model writes the bound; it may write `19.04.2024` as easily as `2024-04-19`.
- No filter on an encrypted column may become an oracle over its plaintext (ADR-0098, #1849).
- A legacy cell (a `date` column imported before #1845) must not fail the whole query.

## Considered Options

- **A — Compare as wall-clock timestamps, parse the bound with the import's parser, keep the
  encrypted-column refusal.**
- **B — Compare the ISO strings as text.**
- **C — Also allow ranges on encrypted date columns, decrypting in the data plane.**

## Decision Outcome

Chosen option: **A**.

- **Comparison.** A `date` cell and a range bound compare as wall-clock timestamps: a date-only
  value is its midnight, a trailing `Z` is read as wall clock (the import turns every offset
  into `Z`). plugin-api exports `DATASET_DATE_VALUE_PATTERN` and `datasetDateTime(value)`; the
  in-memory backend compares `datasetDateTime` values, the Neon backend
  `CASE WHEN cell ~ pattern THEN cell::timestamp END` against `$bound::timestamp`.
- **Bound.** The graph accepts an ISO date or datetime (`yyyy-mm-dd`,
  `yyyy-mm-ddThh:mm[:ss[.f]][Z]`); anything else is `invalid_date_value`. The `query_dataset`
  tool first reads a string bound with `normaliseDateFilterValue` (`datasetDates.ts`, the
  import's parser): ISO with offsets, `d.m.yyyy`, `d/m/yyyy` (day-first; month-first only when
  the day is above 12), with an optional time. Its error names these formats and does not echo
  the bound.
- **Columns.** Ranges are allowed on `number` and `date` columns. A column holding an `enc1:`
  cell stays refused for every filter op (`encrypted_column`), ranges included.
- **Legacy cells.** A cell that is not in the stored ISO form never matches a range.

### Consequences

- 🟢 **Good:** date questions ("due in April", "since 1.3.") are one filtered query instead of
  an unfiltered page the model has to sort through.
- 🟢 **Good:** a range on a clear-at-rest column reveals nothing an `eq` filter or a number
  range on the same column does not already reveal; results are interned behind the shield
  as before.
- 🔴 **Bad:** a date column of a flagged (encrypted) kind, such as a birthday, still cannot be
  filtered. Accepted: a range over plaintext the model never sees is a bisection oracle, and
  the backends hold no key.
- 🔴 **Bad:** rows of a dataset imported before #1845 with non-ISO date cells silently drop out
  of a range. Re-importing the file fixes it; no backfill.
- ⚪ **Neutral:** a date-only bound means midnight, so "through 30 April" on a datetime column
  is `lt 2024-05-01`. The tool description says so.

## Pros and Cons of the Options

### A — Wall-clock timestamps, import parser, encrypted refusal kept

- 🟢 Date order, whatever mix of date and datetime cells a column has.
- 🟢 One parser for import and filter; the same rows on both backends.
- 🔴 A second pattern (the stored ISO form) lives in plugin-api next to the import's parser.

### B — Text comparison of ISO strings

- 🟢 No cast, no new helper.
- 🔴 `2024-04-19T10:30:00Z` vs `2024-04-19T10:30` and fractions sort by spelling, not time; a
  legacy `19.04.2024` cell sorts among real dates.

### C — Ranges on encrypted columns, decrypted in the data plane

- 🟢 Birthdays and other flagged dates become filterable.
- 🔴 Repeated ranges recover a plaintext the model must not read (bisection); the graph
  backends have no key, so every query would need a decrypting pass in the kernel.

## More Information

- Code: `middleware/packages/plugin-api/src/knowledgeGraph.ts` (`datasetDateTime`,
  `validateDatasetQueryOptions`), `harness-knowledge-graph-neon/src/neonKnowledgeGraph.ts`
  (`dateRangeClause`), `harness-knowledge-graph-inmemory/src/inMemoryKnowledgeGraph.ts`
  (`compareDateRange`), `harness-orchestrator/src/datasetDates.ts`
  (`normaliseDateFilterValue`), `harness-orchestrator/src/tools/queryDatasetTool.ts`.
- Tests: `middleware/test/datasetDateRangeFilter2302.test.ts`,
  `middleware/test/neonDatasetDateRange2302.pg.test.ts`.
