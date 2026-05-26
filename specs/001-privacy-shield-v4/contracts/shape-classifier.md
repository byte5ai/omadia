# Contract: Shape Classifier (deny-by-default)

Phase 1 output. The authoritative classification rules: how every field of an
interned result is decided `safe-cleartext` or `sensitive-masked`. The
classifier uses **JSON shape + per-column value statistics only** — no domain,
tool, or schema knowledge — so it is generic across every current and future
tool (FR-005, FR-025).

This is one of the three documents requiring Phase 0 design-review sign-off.

## 1. The deny-by-default rule

```text
classify(field):
    if presidio_hit(field)          -> sensitive-masked      (D4 booster, one-way)
    if field matches the SAFE allowlist -> safe-cleartext
    otherwise                        -> sensitive-masked     (default — FR-008)
```

The allowlist is the **only** path to `safe-cleartext`. Anything not positively
recognized is masked. An unknown field, an unrecognized shape, a type the
classifier has no rule for — all default to `sensitive-masked` (over-masked,
never leaked).

## 2. The `safe-cleartext` allowlist

A field is `safe-cleartext` **only** when it matches one of these — and the
Presidio booster has not fired (§4):

| # | Safe shape | Recognition rule |
|---|---|---|
| S1 | **Numeric** | Every non-null value is a JSON number. |
| S2 | **Boolean** | Every non-null value is a JSON boolean. |
| S3 | **ISO-8601 date / datetime** | Every non-null value matches the ISO-8601 date or datetime grammar. |
| S4 | **Low-cardinality enum / categorical** | String field where `distinctCount ≤ ENUM_MAX_DISTINCT` **and** `cardinalityRatio ≤ ENUM_MAX_RATIO` — a small fixed value set, not free text. |
| S5 | **Opaque identifier (row handle)** | A field whose values are opaque tokens (numeric IDs, UUIDs, short slugs) with high uniqueness — treated as a **pseudonymous row handle**, surfaced as a handle, never as content (Digest invariant I4). |

Everything else is `sensitive-masked`, including:

- All free text and prose.
- Every high-cardinality or unique-per-row string that is **not** an opaque
  identifier (S5) — i.e. human-readable unique strings: names, emails, addresses.
- Every nested object/array the classifier cannot resolve to a known shape.
- Every field with mixed or unrecognized types.

## 3. Column value statistics

For each field the classifier computes, over the interned rows:

| Statistic | Definition | Used by |
|---|---|---|
| `distinctCount` | number of distinct non-null values | S4, S5 |
| `rowCount` | rows in the dataset | ratios |
| `cardinalityRatio` | `distinctCount / rowCount` | S4 (low ⇒ enum), S5 (high ⇒ handle) |
| `uniquePerRow` | `distinctCount === rowCount` | S5 vs. masked-name disambiguation |
| `valueShape` | numeric / boolean / ISO-date / token / free-text | S1–S5 |
| `presidioHit` | any value triggered the NER booster | §4 |

### S5 vs. masked-name disambiguation

A high-cardinality, unique-per-row string is ambiguous: it could be an opaque
identifier (safe handle, S5) or a human name (masked). The classifier resolves
it by **value shape only**:

- `valueShape = token` (no internal whitespace, matches an ID/UUID/slug pattern,
  not dictionary-word-like) ⇒ S5 `id`, `safe-cleartext` as a handle.
- `valueShape = free-text` (whitespace, word-like, mixed case) ⇒
  `sensitive-masked`.
- **Ambiguous ⇒ `sensitive-masked`** (the deny-by-default tiebreak).

## 4. Presidio booster — one-way only (D4)

The Presidio NER detector (`regexDetector.ts`, repurposed) is a **secondary
booster**, never a gate:

- A detector **hit** on any value of a field ⇒ the field is forced
  `sensitive-masked`, overriding any allowlist match.
- The **absence** of a hit ⇒ **no effect**. It MUST NOT promote a field to
  `safe-cleartext`. Safety is decided by the allowlist + statistics alone.

Rationale: Presidio recall is too low to gate on (it misses German surnames),
but a positive hit is real signal worth acting on. One-way use captures the
precision without letting a miss become a leak.

## 5. Tunable thresholds

The thresholds are configuration, not magic numbers in code. Initial defaults:

| Threshold | Default | Meaning |
|---|---|---|
| `ENUM_MAX_DISTINCT` | `12` | max distinct values for S4 (enum) |
| `ENUM_MAX_RATIO` | `0.10` | max `cardinalityRatio` for S4 |
| `INLINE_VALUES_MAX_ROWS` | `25` | below this `rowCount`, `safe-cleartext` values are inlined in the Digest; above it, summarized |

> [NEEDS CLARIFICATION: confirm the default threshold values against the live
> `hr.leave` fixture and 2–3 other real tool shapes during US2 — they are tuned
> empirically, and over-masking (too-low thresholds) is the safe direction.]

## 6. Classification verdict

The output for each field is a `FieldClassification` (see `data-model.md`):
`path`, `type`, `classification`, and the `stats` that produced the verdict. The
`stats.presidioHit` and the statistics are retained so a verdict is **auditable**
— a reviewer can see *why* a field was masked or cleared.

## 7. Test obligations (US2)

The classifier ships with coverage that includes:

1. Each allowlist row S1–S5 with a positive fixture.
2. Free text, unique-per-row human names, and mixed-type fields ⇒ all
   `sensitive-masked`.
3. An unrecognized / never-before-seen shape ⇒ `sensitive-masked` (FR-008,
   SC-004).
4. The live `hr.leave` shape — every name field masked, every numeric/date field
   cleartext.
5. Presidio booster: a value with an NER hit forces masking even on an
   otherwise-S4 enum field; a field with no hit is **not** promoted.
