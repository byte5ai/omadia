# Data Model: Privacy Shield v4 — Data-Plane Boundary

Phase 1 output. Entities and in-memory runtime structures. v4 introduces **no
persistent schema** — every structure is turn-scoped and in-memory (D6). TypeScript
shapes below are illustrative; the authoritative contract types live in
`contracts/` and ship from `harness-plugin-privacy-guard/src/v4/types.ts`.

## Entity Overview

| Entity | Kind | Lifetime |
|---|---|---|
| Dataset | runtime (in-memory) | turn-scoped, dropped at `finalizeTurn` |
| Dataset Store | runtime (in-memory) | one per turn |
| Field Classification | runtime (computed) | with the Dataset that produced it |
| Dataset Schema | runtime (computed) | with its Dataset |
| Digest | runtime (LLM-bound) | rebuilt for each Dataset/verb output |
| Verb Invocation | runtime (transient) | one orchestrator tool call |
| Render Directive | runtime (LLM-emitted) | one final answer |
| Pseudonym Map | runtime (in-memory) | turn-scoped, gated by US7 |
| Privacy Receipt | runtime (user-facing) | one per turn |

There is no DB table, no migration, and no `LISTEN/NOTIFY` for this feature.

## Runtime Structures (in-memory)

### `Dataset`

The interned, server-held tool result. The `rows` field never leaves the server.

```ts
interface Dataset {
  datasetId: string;            // opaque turn-unique handle
  rows: unknown[];              // the REAL data — server-only, never serialized to the LLM
  schema: DatasetSchema;        // field list + per-field classification
  provenance: {
    toolName: string;           // originating tool, or a verb name for a derived dataset
    turnId: string;
    derivedFrom?: string;       // datasetId of the input, when produced by a verb
    truncated: boolean;         // true if bounded at intern time (C4)
    createdAt: string;          // ISO-8601
  };
}
```

- A Dataset is produced either by `internToolResult` (US1) or by a Verb (US5);
  a verb output is a first-class Dataset with its own `datasetId`.
- `rows` is the single piece of state the boundary exists to keep off the wire.

### `DatasetSchema` & `FieldClassification`

```ts
interface DatasetSchema {
  fields: FieldClassification[];
  rowCount: number;
  shape: 'rows' | 'object' | 'scalar' | 'nested';  // non-tabular results too
}

interface FieldClassification {
  path: string;                 // key path, e.g. "employee_id" or "manager.name"
  type: 'number' | 'boolean' | 'date' | 'enum' | 'id' | 'string' | 'unknown';
  classification: 'safe-cleartext' | 'sensitive-masked';
  stats: {
    distinctCount: number;
    uniquePerRow: boolean;      // distinctCount === rowCount
    cardinalityRatio: number;   // distinctCount / rowCount
    presidioHit: boolean;       // a value triggered the NER booster (D4)
  };
}
```

- `classification` is decided per the deny-by-default rules in
  `contracts/shape-classifier.md`.
- An `unknown` type always yields `sensitive-masked` (FR-008).
- `id`-typed fields are `safe-cleartext` **as a pseudonymous row handle** — the
  handle may be shown to the LLM and used in predicates; it is not surfaced as
  human-readable content.

### `Digest`

The identity-free stand-in the LLM receives in place of a Dataset (FR-010). It
is what a `tool_result` block carries when the v4 flag is on.

```ts
interface Digest {
  datasetId: string;
  rowCount: number;
  truncated: boolean;
  fields: FieldDigest[];
}

type FieldDigest =
  | { path: string; type: SafeType; classification: 'safe-cleartext';
      values?: unknown[];        // for low row counts
      summary?: SafeSummary; }   // for larger results: min/max/distinct enum members
  | { path: string; type: string; classification: 'sensitive-masked';
      placeholder: string;       // e.g. "‹masked string›"
      distinctCount: number; };  // a count only — never a value
```

**Invariant**: a `Digest` contains no identity-bearing value. This invariant is
the assertion target of the on-the-wire harness (US4, SC-006). Digest size is a
function of `rowCount` + schema, not of row content length (SC-008).

### `DatasetStore`

The turn-scoped registry of Datasets.

```ts
interface DatasetStore {
  internToolResult(toolName: string, rawResult: unknown): { datasetId: string; digest: Digest };
  get(datasetId: string): Dataset | undefined;   // server-side only
  put(dataset: Dataset): Digest;                 // for verb outputs
  finalizeTurn(turnId: string): void;            // drops every dataset for the turn
}
```

- Held inside the privacy-guard plugin instance — never module-scope state
  (Constitution I).
- `internToolResult` applies the intern-time size bound (C4) before storing.

### `Verb` & `VerbInvocation`

A verb is a server-side operation over one or two `datasetId`s, producing a new
Dataset. The LLM calls verbs as individual tool calls (D7).

```ts
type VerbName =
  | 'filter' | 'sort' | 'group' | 'aggregate'
  | 'top_n' | 'select' | 'count' | 'join';

interface VerbInvocation {
  verb: VerbName;
  input: string | [string, string];   // datasetId(s)
  params: Record<string, unknown>;     // verb-specific; see contracts/verb-api.md
}

interface VerbResult {
  datasetId: string;     // a NEW dataset
  digest: Digest;
}
```

- Predicates inside `params` may reference only `safe-cleartext` fields and row
  handles; a reference to a `sensitive-masked` field is rejected (FR-014, C3).
- Verb outputs are composable: a `VerbResult.datasetId` is a valid `input`.

### `RenderDirective`

The LLM's final-answer instruction to the Materializer.

```ts
interface RenderDirective {
  datasetId: string;                       // which dataset to render
  columns: string[];                       // field paths, incl. sensitive-masked ones
  format: 'table' | 'list' | 'scalar';
  prose?: string;                          // PII-free surrounding prose from the LLM
}
```

- `columns` MAY name `sensitive-masked` fields: the Materializer renders their
  **real** values into the channel output for the authorized user (FR-016/FR-017).
- An unknown `datasetId` or column path is rejected, not guessed (FR-019).

### `PseudonymMap` (US7, gated)

```ts
interface PseudonymMap {
  forward: Map<string, string>;   // real value -> stable pseudonym
  reverse: Map<string, string>;   // pseudonym -> real value
}
```

- Built only when an operation needs per-person prose (D8).
- A candidate pseudonym is rejected if it appears in the dataset's real-name set
  (C5). The map is held server-side and resolved at materialization (FR-021).

### `PrivacyReceipt` (adapted — US9)

The per-turn user-facing report, re-expressed in v4 terms (FR-028).

```ts
interface PrivacyReceiptV4 {
  datasetsInterned: number;
  fieldsMasked: number;          // count of sensitive-masked fields across datasets
  fieldsCleartext: number;
  verbsExecuted: VerbName[];
  pseudonymProjectionUsed: boolean;
}
```

- Replaces the v2/v3 token-count receipt; assembled by `receiptAssembler.ts`.

## Relationships

```text
DatasetStore 1───n Dataset            (a store holds many datasets per turn)
Dataset      1───1 DatasetSchema      (each dataset has one computed schema)
DatasetSchema 1──n FieldClassification
Dataset      1───1 Digest             (the LLM-bound projection of a dataset)
Verb         n───1 Dataset (input)  + 1───1 Dataset (output)
RenderDirective n──1 Dataset          (the final answer renders one dataset)
PseudonymMap 0..1─1 Dataset           (an optional projection of one dataset)
PrivacyReceipt 1──n Dataset           (one receipt summarises a turn's datasets)
```

## Validation Rules

- **Digest identity-free invariant**: no `FieldDigest` for a `sensitive-masked`
  field carries a value — only a placeholder and a `distinctCount` (FR-010).
- **Intern-time bound**: `internToolResult` truncates a result exceeding the
  `MAX_OUTPUT_CHARS`-style limit and sets `provenance.truncated` +
  `Digest.truncated` (C4).
- **Predicate scope**: a verb predicate referencing a `sensitive-masked` field
  is rejected before execution (FR-014).
- **Verb input resolution**: a `datasetId` that does not resolve in the current
  turn's store is rejected (datasets are turn-scoped, C1).
- **Render directive resolution**: an unknown `datasetId` or column path is
  rejected with a precise error; the Materializer never renders a guess (FR-019).
- **Pseudonym uniqueness**: a generated pseudonym MUST NOT equal any real value
  in the dataset's real-name set, and MUST be stable per individual per turn
  (FR-021, C5).
- **Turn isolation**: `finalizeTurn` drops every dataset, schema, digest, and
  pseudonym map for the turn; nothing v4 survives the turn boundary (FR-003).
