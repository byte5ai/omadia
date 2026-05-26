# Contract: Dataset Store & Digest

Phase 1 output. The authoritative interface for interning a tool result and for
the identity-free Digest the LLM receives in its place. These types ship from
`harness-plugin-privacy-guard/src/v4/types.ts` and are the **single source of
truth** (Constitution II) — the orchestrator imports them through the
`privacyHandle` capability seam and never re-declares them.

This is one of the three documents requiring Phase 0 design-review sign-off.

## 1. `internToolResult`

The entry point of the Data-Plane Boundary. Every tool result passes through it
before it can influence an LLM-bound message (FR-001/FR-002).

```ts
// harness-plugin-privacy-guard/src/v4/datasetStore.ts

/** Intern a raw tool result. Stores the real rows server-side behind a
 *  datasetId and returns the identity-free Digest the LLM may see.
 *  The raw result is NEVER returned to a caller that serializes to the LLM. */
function internToolResult(
  toolName: string,
  rawResult: unknown,
): { datasetId: string; digest: Digest };
```

Behaviour:

1. Parse `rawResult` into `{ rows, schema }`. Non-tabular results (scalar,
   single object, deeply nested) are accepted — `schema.shape` records which.
2. Apply the intern-time size bound (§4); set `truncated` if it fires.
3. Run the Shape Classifier (`contracts/shape-classifier.md`) to produce a
   `FieldClassification` per field.
4. Store the `Dataset` in the turn's `DatasetStore`.
5. Assemble and return the `Digest` (§3).

`internToolResult` MUST be total: a result it cannot parse is interned as a
single `sensitive-masked` scalar/blob, never thrown back into the dispatch path.

## 2. `DatasetStore`

Turn-scoped, in-memory. Held inside the privacy-guard plugin instance — never
module-scope state (Constitution I).

```ts
interface DatasetStore {
  /** US1 — intern a raw tool result (see §1). */
  internToolResult(toolName: string, rawResult: unknown): { datasetId: string; digest: Digest };

  /** US5 — register a verb output as a first-class Dataset; returns its Digest. */
  put(dataset: Dataset): Digest;

  /** Server-side resolution of the real rows. Callable ONLY by trusted code
   *  (verbs, the Materializer). Its result MUST NOT be serialized to the LLM. */
  get(datasetId: string): Dataset | undefined;

  /** Drop every Dataset, Digest, and PseudonymMap for the turn (FR-003). */
  finalizeTurn(turnId: string): void;
}
```

Rules:

1. **`datasetId` is opaque and turn-unique.** It carries no information about
   row content. It does not resolve outside its originating turn (C1).
2. **`get` is trusted-only.** Verbs and the Materializer call it; no code path
   that serializes to the LLM may call it. This is enforced by construction —
   `get` lives behind the boundary and the orchestrator dispatch seam never
   receives a `Dataset`, only a `Digest`.
3. **`finalizeTurn` is total and idempotent.** After it runs, no `datasetId`
   from that turn resolves.

## 3. The `Digest`

What the LLM receives in place of a raw result (FR-010). It is the payload of a
`tool_result` block and of every `VerbResult` when the v4 flag is on.

```ts
interface Digest {
  datasetId: string;
  rowCount: number;
  truncated: boolean;          // true if the source was bounded at intern time
  fields: FieldDigest[];
}

type SafeType = 'number' | 'boolean' | 'date' | 'enum' | 'id';

type FieldDigest =
  // safe-cleartext: the LLM may see actual values / summaries
  | {
      path: string;
      type: SafeType;
      classification: 'safe-cleartext';
      values?: unknown[];      // included when rowCount is small (≤ inline threshold)
      summary?: {              // included for larger results instead of values
        min?: unknown;
        max?: unknown;
        distinctValues?: unknown[];  // only for low-cardinality enums
      };
    }
  // sensitive-masked: the LLM sees a placeholder + a count, never a value
  | {
      path: string;
      type: string;
      classification: 'sensitive-masked';
      placeholder: string;     // e.g. "‹masked string›"
      distinctCount: number;   // a COUNT only — never an actual value
    };
```

### Digest invariants (the design contract)

- **I1 — Identity-free.** No `FieldDigest` of classification `sensitive-masked`
  carries any value, sample, prefix, suffix, or hash of a real value. Only a
  fixed placeholder string and an integer `distinctCount`. This invariant is the
  assertion target of the on-the-wire harness (US4, SC-006).
- **I2 — Size is shape-bounded.** Digest size is a function of `rowCount` and
  field count, not of row content length (SC-008). `values` is inlined only
  below a small row-count threshold; above it, `summary` is used.
- **I3 — Truncation is surfaced.** If the source was bounded at intern time,
  `truncated` is `true` so the LLM does not reason over a dataset it believes is
  complete.
- **I4 — Handles, not content.** An `id`-typed field is `safe-cleartext` and its
  values MAY appear in the Digest as **row handles** — opaque tokens usable in
  predicates — never as human-readable content.

## 4. Intern-time size bound

`internToolResult` MUST bound the dataset at intern time, reusing the existing
`MAX_OUTPUT_CHARS`-style limit already applied to tool output (C4):

- A result whose serialized size exceeds the limit is truncated to a prefix of
  whole rows.
- `Dataset.provenance.truncated` and `Digest.truncated` are both set.
- The Digest's `rowCount` reflects the **retained** row count.

Rationale: one limit, one place; truncation surfaced rather than silent so the
LLM never ranks over a dataset it wrongly believes is complete.

## 5. Orchestrator consumption contract

The orchestrator wires the boundary at two dispatch seams (US3):

- `Orchestrator.dispatchTool` (`harness-orchestrator/src/orchestrator.ts`)
- `LocalSubAgent.dispatch` (`harness-orchestrator/src/localSubAgent.ts`)

Guarantees the orchestrator MUST uphold:

1. When the v4 flag is **on**, the value placed in a `tool_result` block is the
   `Digest` returned by `internToolResult` — never the raw result.
2. When the v4 flag is **off**, the existing v2/v3 path runs unchanged; v4 code
   is not invoked (FR-026).
3. A sub-agent tool dispatch is interned on the same boundary as a top-level
   dispatch — there is no unguarded path to the LLM.
4. The orchestrator calls `finalizeTurn` exactly once per turn, in the same
   place the v2 tokenize-map is currently torn down.
