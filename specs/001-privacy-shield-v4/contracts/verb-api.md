# Contract: Verb API & Render Directive

Phase 1 output. The authoritative surface for the server-side operations the LLM
*composes* over `datasetId`s, and for the render directive that produces the
final answer. This is guarantee **G2**: identity- and order-critical work runs
in trusted code; the LLM never executes it and never sees a row.

This is one of the three documents requiring Phase 0 design-review sign-off.

## 1. Composition model

Verbs are exposed to the LLM as **individual tool calls** (D7/C2). Each call:

- takes one or two `datasetId`s + verb-specific params,
- runs in trusted server code against the **real** Dataset,
- registers a **new** Dataset in the turn store and returns a `VerbResult`
  (`{ datasetId, digest }`).

Because each result is itself a `datasetId`, verbs **compose**: the LLM chains
`filter` → `sort` → `top_n` by passing one verb's output `datasetId` as the next
verb's input. The LLM sees only Digests throughout (FR-011/FR-012).

```ts
type VerbName =
  | 'filter' | 'sort' | 'group' | 'aggregate'
  | 'top_n' | 'select' | 'count' | 'join';

interface VerbResult { datasetId: string; digest: Digest; }
```

## 2. The eight verbs

| Verb | Input | Params | Output dataset |
|---|---|---|---|
| `filter` | 1 | `predicate` (§3) | rows matching the predicate |
| `sort` | 1 | `by` (field path or aggregate alias), `direction: 'asc'\|'desc'` | rows reordered |
| `group` | 1 | `by` (one or more `safe-cleartext` field paths) | one row per group + group key |
| `aggregate` | 1 | `ops: { alias, fn: 'count'\|'sum'\|'min'\|'max'\|'avg', field? }[]` | aggregate rows |
| `top_n` | 1 | `n` (integer), `by`, `direction` | the first `n` rows after sorting |
| `select` | 1 | `columns` (field paths / handles) | projection to those columns |
| `count` | 1 | — | a scalar dataset: one row, one `safe-cleartext` number |
| `join` | 2 | `on` (`safe-cleartext` field/handle pair) | the joined dataset |

Rules:

1. `sort`, `group`, `aggregate`, `top_n` are the **order/identity-critical**
   operations the LLM must NOT do itself (FR-013) — they run here, on real data.
2. `aggregate` numeric functions (`sum`, `min`, `max`, `avg`) operate only on
   `safe-cleartext` numeric fields. `count` operates on any field (it counts
   rows / non-nulls, never reads a value).
3. `group` / `join` keys MUST be `safe-cleartext` fields or row handles — never
   `sensitive-masked` fields (a join on a name would reconstruct identity).
4. Every verb output carries provenance (`derivedFrom` = input `datasetId`).

## 3. Predicate grammar (`filter`)

A **bounded, safe expression grammar** — no arbitrary code, no string operations
over masked fields (C3). The predicate is a JSON tree, not a string to `eval`.

```ts
type Predicate =
  | { op: 'eq'|'ne'|'lt'|'lte'|'gt'|'gte'; field: string; value: Scalar }
  | { op: 'in';      field: string; values: Scalar[] }
  | { op: 'between'; field: string; lo: Scalar; hi: Scalar }
  | { op: 'and'|'or'; clauses: Predicate[] }
  | { op: 'not'; clause: Predicate };

type Scalar = number | boolean | string;   // string only for enum/handle fields
```

### Predicate validation (rejected before execution)

- **P1 — Safe fields only.** Every `field` MUST resolve to a `safe-cleartext`
  field or a row handle in the input dataset's schema. A reference to a
  `sensitive-masked` field is **rejected** with a precise error (FR-014). This
  blocks the LLM from binary-searching identity values through predicates.
- **P2 — Closed operator set.** Only the operators above. No regex, no
  `contains`/`like`, no arithmetic, no function calls.
- **P3 — Type agreement.** A comparison's `value` type MUST match the `field`
  type (numeric op on numeric field, etc.).
- **P4 — Bounded depth.** Nesting of `and`/`or`/`not` is depth-limited to keep
  evaluation cheap and the surface non-pathological.

## 4. Render Directive

The LLM's final answer is PII-free prose **plus** a render directive. A
server-side Materializer (US6) fills it from ground truth.

```ts
interface RenderDirective {
  datasetId: string;                  // the dataset to render (often a verb output)
  columns: string[];                  // field paths — MAY include sensitive-masked ones
  format: 'table' | 'list' | 'scalar';
  prose?: string;                     // PII-free surrounding text from the LLM
}
```

Materializer rules:

1. **Real values, server-side.** The Materializer resolves `datasetId` via
   `DatasetStore.get` and renders the **real** values of `columns` — including
   `sensitive-masked` columns — into the **channel-bound output** for the
   authenticated internal user (FR-016/FR-017). G1 protects the LLM wire, not
   the end user.
2. **No guessing.** An unknown `datasetId`, an unresolved column path, or a
   `format` that does not fit the dataset shape is **rejected** with a precise
   error — never rendered as a guess (FR-019).
3. **Reuse.** The Materializer is a generalization of
   `middleware/src/plugins/routines/routineTemplateRenderer.ts`; the pre-defined
   routine path keeps working unchanged (FR-018, D5).

## 5. Pseudonym Projection interaction (US7)

When an operation needs per-person prose, the server may release a Pseudonym
Projection of a dataset (D8) before the LLM composes prose:

- `sensitive-masked` fields carry stable, realistic **pseudonyms** drawn through
  the deny-by-default filter; the pseudonym↔real map is server-held.
- The LLM composes prose over pseudonyms; verbs still run on the real dataset.
- At materialization the pseudonyms are resolved back to **real** names in the
  channel output. Neither the real value nor the fake value of a masked field
  ever needs to leave as content — the projection only ever exposes pseudonyms,
  and only when gated on (FR-020–FR-022).

## 6. Test obligations (US5)

1. Each verb against fixtures, output digest correct and identity-free.
2. Composition: `filter` → `sort` → `top_n` chains, output `datasetId`s resolve.
3. **Correctness vs. reference (SC-007):** a `sort` → `top_n` ranking equals a
   trusted reference computation over the raw rows — same order, no duplicates,
   no invented rows.
4. Predicate validation P1–P4: a predicate over a `sensitive-masked` field is
   rejected; a closed-set violation is rejected; type mismatch is rejected.
5. `group`/`join` on a `sensitive-masked` key is rejected.
