# Feature Specification: Privacy Shield v4 — Data-Plane Boundary

**Feature Branch**: `feat/privacy-shield-v4`
**Created**: 2026-05-21
**Status**: Draft
**Input**: Privacy Shield v2 (stream tokenization) and v3 (stable-id tokenization)
are declared a dead end and are replaced — not patched — by a new architecture.
Every prior version is *blocklist thinking*: data flows to the public LLM by
default and the system tries to detect PII and tokenize it out. Detection is
never complete (Presidio misses German surnames), and the LLM is kept in the
data path holding fragile `«PERSON_N»` tokens it paraphrases, drops, and
mis-places. The failure of record is the HR-Urlaubsranking screenshot of
2026-05-18 — partial names, invented labels ("Platz 2"), wrong ranks. The
operator wants privacy and answer-correctness solved at their shared root cause:
take the LLM out of the data path. Nothing reaches the LLM unless proven safe;
identity- and order-critical work runs in trusted server code; the final answer
is rendered server-side from ground truth.

## Overview

Privacy Shield v4 inverts the default. Today a raw tool result is serialized
straight into the LLM-bound conversation and a detector tries to scrub it. v4
introduces a **Data-Plane Boundary**: a raw tool result is *interned* into a
turn-scoped, server-held **Dataset Store** and the LLM receives only a small,
identity-free **Digest** (`datasetId` + schema + safe values + masked-field
counts). Identity- and order-critical operations — sort, rank, group,
aggregate, filter, join — run server-side through a **Verb API** that the LLM
*composes* but never *executes*. The final answer is produced by a server-side
**Materializer** that renders real values from the real dataset directly into
the channel output for the authenticated internal user.

Two guarantees are enforced **structurally**, not heuristically:

- **G1 — Confidentiality**: a raw tool result is *never* serialized into an
  LLM-bound message. Critical data physically cannot reach the LLM.
- **G2 — Correctness**: identity- and order-critical operations run in trusted
  server code; the LLM composes them; the final answer is joined against ground
  truth, never trusted from the LLM's output.

Because v4 operates on **JSON shape + value statistics only** — never
domain knowledge — every current and future tool is covered by construction.
There is no `piiFields` list to maintain and no NER recall to chase.

Out of scope (handled elsewhere, deferred, or unchanged):

- **`ensureWellFormedParams`** (outbound surrogate hardening, `omadia` PR #118)
  — fully orthogonal to the data-plane boundary; it stays exactly as-is.
- **Per-record / per-user authorization** of who may see PII — unchanged. v4
  protects the LLM wire; the authenticated internal user remains authorized to
  see real PII in the final answer.
- **Cross-turn dataset reuse** — v1 datasets are turn-scoped; a follow-up that
  needs an earlier result re-runs the tool (see Clarifications C1).
- **Removal of v2/v3 code** — v3 (`omadia` PR #86, `omadia-byte5-plugins` PR #1)
  stays merged but additive-inactive until the cut-over passes, then is deleted
  in US9. No further fixes go into the v2/v3 line.

## Clarifications

### Session 2026-05-21

- Q: Should an interned dataset survive across conversation turns? → A: No —
  turn-scoped for v1, dropped at `finalizeTurn` (mirrors the v2 tokenize-map
  lifecycle). A follow-up that needs an earlier result re-runs the tool. See
  research C1.
- Q: How does the LLM compose verbs — individual tool calls or one mini-DSL?
  → A: Individual tool calls for v1 — simpler to validate, no grammar to parse;
  a DSL is a later round-trip optimization. See research C2.
- Q: What may a `filter` predicate express? → A: A bounded, safe expression
  grammar over `safe-cleartext` fields and pseudonymous row handles only — no
  arbitrary code, no operations over `sensitive-masked` fields. See research C3.
- Q: How is Dataset Store memory bounded? → A: Reuse the existing
  `MAX_OUTPUT_CHARS`-style limit, applied at intern time, so a large
  `search_read` cannot exhaust memory. See research C4.
- Q: How is a pseudonym kept from colliding with a real person? → A: The fake
  pool is drawn against the dataset's real-name set, so a generated pseudonym
  can never equal a different real person's name. See research C5.
- Q: How much free-form reasoning over specific individuals must the Pseudonym
  Projection support? → A: [NEEDS CLARIFICATION: scope from real HR/agent
  transcripts before US7 is built — do not over-build]. See research C6.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tool Results Are Interned, Never Serialized to the LLM (Priority: P1)

A platform developer needs every tool result to land in a server-held store
behind a `datasetId` before it can influence anything the LLM sees, so that raw
identity-bearing rows physically cannot reach the model.

**Why this priority**: The Dataset Store is guarantee G1's foundation. Every
other story — Digest, Verb API, Materializer — operates on a `datasetId`.
Producing it last would mean retrofitting every consumer.

**Independent Test**: Call `internToolResult(toolName, rawResult)` with
multi-shape fixtures; confirm it returns `{ datasetId, digest }`, that the raw
rows are retrievable server-side by `datasetId`, and that `finalizeTurn` drops
every dataset for that turn.

**Acceptance Scenarios**:

1. **Given** a raw tool result, **When** it is interned, **Then** the store
   holds `{ rows, schema, provenance }` behind a fresh `datasetId` and returns
   `{ datasetId, digest }`.
2. **Given** an interned dataset, **When** the turn ends via `finalizeTurn`,
   **Then** the dataset is dropped and its `datasetId` no longer resolves.
3. **Given** a tool result larger than the configured intern bound, **When** it
   is interned, **Then** it is truncated at intern time per the
   `MAX_OUTPUT_CHARS`-style limit and the digest reports the truncation.
4. **Given** a non-tabular result (a scalar, a single object, a deeply nested
   shape), **When** it is interned, **Then** it is still stored and digestible
   without error.

---

### User Story 2 - Deny-by-Default Shape Classifier (Priority: P1)

A platform developer needs every field of an interned result classified as
`safe-cleartext` or `sensitive-masked` from JSON shape and column statistics
alone, so that an unknown field is over-masked rather than leaked.

**Why this priority**: The Digest cannot be assembled without a classification
verdict for every field. Allowlisting "safe" is the property that makes G1 hold
for tools the system has never seen.

**Independent Test**: Run the classifier over a multi-shape fixture set
including the live `hr.leave` shape; assert numbers/booleans/ISO-dates/
low-cardinality enums are `safe-cleartext`, every free-text and unique-per-row
string is `sensitive-masked`, and every unrecognized field defaults to
`sensitive-masked`.

**Acceptance Scenarios**:

1. **Given** a numeric, boolean, ISO-date, or low-cardinality enum field,
   **When** it is classified, **Then** the verdict is `safe-cleartext`.
2. **Given** a free-text field, a high-cardinality string, or a unique-per-row
   string, **When** it is classified, **Then** the verdict is
   `sensitive-masked`.
3. **Given** a field of an unrecognized shape or type, **When** it is
   classified, **Then** the verdict defaults to `sensitive-masked`.
4. **Given** a value on which the Presidio detector returns an NER hit, **When**
   the field is classified, **Then** the verdict is forced to
   `sensitive-masked` regardless of shape.
5. **Given** a value on which Presidio returns *no* hit, **When** the field is
   classified, **Then** the absence of a hit never promotes the field to
   `safe-cleartext` — the shape/statistics verdict alone decides safety.

---

### User Story 3 - The LLM Receives a Digest Instead of Raw Tool Output (Priority: P1)

When a tool runs inside an orchestrator turn, the result delivered to the LLM as
the `tool_result` is the identity-free Digest — `datasetId`, row count, schema,
`safe-cleartext` values, and masked-field placeholders + counts — not the raw
JSON.

**Why this priority**: This is the slice where G1 first becomes observable
end-to-end: the LLM literally stops receiving raw data. It is the MVP boundary.

**Independent Test**: With the v4 feature flag on, dispatch a tool in
`Orchestrator.dispatchTool` and in `LocalSubAgent.dispatch`; capture the
`tool_result` block sent to the LLM; assert it is the Digest and contains no
raw row.

**Acceptance Scenarios**:

1. **Given** the v4 flag on, **When** a tool returns a result, **Then** the
   `tool_result` the LLM receives is the Digest and the raw rows are absent from
   the wire.
2. **Given** a Digest, **When** the LLM reads it, **Then** it sees `datasetId`,
   row count, field names + types + classifications, `safe-cleartext` values or
   summaries, and for each `sensitive-masked` field only a placeholder and a
   distinct-value count.
3. **Given** the v4 flag off, **When** a tool returns a result, **Then** the
   existing v2/v3 path runs unchanged and no v4 behaviour is observable.
4. **Given** a sub-agent tool dispatch, **When** it returns a result, **Then**
   it is interned and digested on the same boundary as a top-level dispatch.

---

### User Story 4 - On-the-Wire Confidentiality Is Proven, Not Hoped (Priority: P1)

A security owner needs an automated test harness that inspects every LLM-bound
payload — system prompt, message history, and every `tool_result` — and asserts
that zero identity values appear, turning G1 into a verifiable property.

**Why this priority**: "Critical data never reaches the LLM" is the headline
claim. Without an automated assertion it is an aspiration. The harness must land
with US3, the moment a wire payload exists to inspect.

**Independent Test**: Run the HR-Urlaubsranking turn end-to-end under the
harness; the harness collects every LLM-bound payload and fails if any known
identity value from the dataset's real-name set appears in any of them.

**Acceptance Scenarios**:

1. **Given** a completed turn, **When** the harness inspects every LLM-bound
   payload, **Then** it asserts zero identity values from the dataset's
   real-name set appear in any of them.
2. **Given** a deliberately leaking change, **When** the harness runs in CI,
   **Then** the build fails and names the payload and value that leaked.
3. **Given** the multi-shape fixture set, **When** the harness runs, **Then** it
   confirms no Digest carries an identity-bearing value for any shape.

---

### User Story 5 - Server-Side Verb API for Sort, Rank, Group, Aggregate (Priority: P1)

The LLM composes operations over a `datasetId` — `filter`, `sort`, `group`,
`aggregate`, `top_n`, `select`, `count`, `join` — and a server-side Verb API
executes each on the real dataset, returning a new `datasetId` + Digest. The LLM
composes; it never executes.

**Why this priority**: This is guarantee G2. Without it the LLM, holding only a
Digest, cannot answer "who has the most" — and the v2/v3 failure mode (LLM
mis-ranks identity rows) returns.

**Independent Test**: Compose `sort` then `top_n` over the `hr.leave`
`datasetId`; compare the resulting dataset against a trusted reference
computation over the raw rows; assert identical ranking, no duplicates, no
invented rows.

**Acceptance Scenarios**:

1. **Given** a `datasetId`, **When** the LLM calls a verb, **Then** the verb
   runs server-side on the real dataset and returns a new `datasetId` + Digest.
2. **Given** the output `datasetId` of one verb, **When** it is passed to
   another verb, **Then** verbs compose without the LLM ever seeing a row.
3. **Given** a verb predicate referencing a `safe-cleartext` field or a row
   handle, **When** the verb runs, **Then** it is accepted.
4. **Given** a verb predicate referencing a `sensitive-masked` field, **When**
   the verb is invoked, **Then** it is rejected with a precise error.
5. **Given** a sort/rank/aggregate produced by a verb chain, **When** it is
   compared to a trusted reference over the raw dataset, **Then** the results
   are identical — correctness is independent of the LLM.

---

### User Story 6 - Materializer Renders the Final Answer from Ground Truth (Priority: P1)

The LLM emits a final answer as PII-free prose plus a render directive
(`datasetId`, columns, format). A server-side Materializer renders the real
values from the real dataset into the channel output for the authenticated
internal user.

**Why this priority**: This closes the loop — without it the boundary protects
the LLM but the user never sees real names. It is the last P1: after it, the
HR-Urlaubsranking case produces a real, correct answer.

**Independent Test**: Drive the HR-Urlaubsranking turn; confirm the
channel-bound answer shows real, complete employee names with correct ranks,
while the on-the-wire harness (US4) still reports zero identity values.

**Acceptance Scenarios**:

1. **Given** a render directive `{ datasetId, columns, format }`, **When** the
   Materializer runs, **Then** it renders the real values of those columns from
   the real dataset into the channel output.
2. **Given** a rendered answer, **When** it is delivered, **Then** real
   identity values appear only in the channel-bound output and never pass back
   through the LLM.
3. **Given** a render directive referencing an unknown `datasetId` or a
   non-existent column, **When** the Materializer runs, **Then** it rejects the
   directive with a precise error rather than rendering a guess.
4. **Given** the existing `routineTemplateRenderer`, **When** the Materializer
   is built, **Then** it reuses that renderer, generalized from pre-defined
   routines to ad-hoc directives — the routine path keeps working unchanged.

---

### User Story 7 - Pseudonym Projection for Individual-Level Prose (Priority: P2)

For the rare case where the LLM must reason in prose about specific individuals,
the server releases a projection in which `sensitive-masked` fields are replaced
by stable, realistic pseudonyms drawn through the same deny-by-default filter;
the pseudonym↔real map is held server-side and resolved at materialization.

**Why this priority**: Most answers (rankings, aggregates, tables) are served by
the Verb API + Materializer without ever naming a person to the LLM. Pseudonym
Projection is the gated fallback for genuine free-form reasoning — valuable but
not on the critical path to the acceptance case.

**Independent Test**: Request an answer that requires per-person prose; confirm
the LLM sees stable pseudonyms, the pseudonyms never equal a real different
person's name, and the Materializer resolves them back to real names in the
channel output.

**Acceptance Scenarios**:

1. **Given** an operation needing per-person prose, **When** a projection is
   released, **Then** `sensitive-masked` fields are replaced by stable,
   realistic pseudonyms and the pseudonym↔real map is held server-side.
2. **Given** a projection, **When** the same individual appears more than once,
   **Then** the pseudonym is stable across the turn.
3. **Given** a generated pseudonym, **When** it is checked, **Then** it does not
   equal any real value in the dataset's real-name set.
4. **Given** an answer composed over pseudonyms, **When** it is materialized,
   **Then** the pseudonyms are resolved back to real names in the channel
   output and never leak as either fake or real to the LLM wire.
5. **Given** an operation that does not need per-person prose, **When** it runs,
   **Then** Pseudonym Projection stays off — it is opt-in, never the default.

---

### User Story 8 - HR Agent Cut-Over and Acceptance Run (Priority: P2)

The operator switches the HR agent onto the v4 path and runs the acceptance
case — "Wer hat dieses Jahr den meisten Urlaub?" — against the §Success Criteria
to prove v4 replaces v2/v3 on the failure of record.

**Why this priority**: The cut-over is the moment v4 delivers value to a real
agent. It depends on the full P1 chain (US1–US6) plus US4's proof harness.

**Independent Test**: With the v4 flag on for the HR agent, ask "Wer hat dieses
Jahr den meisten Urlaub?"; verify the answer against SC-001/SC-002 and the wire
against SC-003.

**Acceptance Scenarios**:

1. **Given** the HR agent on the v4 path, **When** the user asks the
   Urlaubsranking question, **Then** the answer shows real, complete names —
   no tokens, no partial names, no invented labels.
2. **Given** the same answer, **When** ranks are checked, **Then** they are
   correct, with no duplicated and no invented people.
3. **Given** the same turn, **When** the on-the-wire harness inspects every
   LLM-bound payload, **Then** zero identity values appear.
4. **Given** a fresh tool/plugin with no privacy-specific annotation, **When**
   the HR agent uses it, **Then** its output is interned and deny-by-default
   classified by construction.

---

### User Story 9 - Remove v2/v3 Tokenization Machinery (Priority: P3)

Once the cut-over passes acceptance, the v2 `selfAnonymization` machinery and
the v3 stable-id tokenization are deleted and the Privacy Receipt is adapted to
report v4 concepts, so no dead blocklist code remains.

**Why this priority**: Pure cleanup. It must come last — it is safe only after
US8 proves v4 on the failure of record. `ensureWellFormedParams` is explicitly
kept.

**Independent Test**: Remove the v2/v3 code; run the full middleware suite and a
boot smoke test; confirm green and that the Privacy Receipt renders v4 fields.

**Acceptance Scenarios**:

1. **Given** a passed cut-over, **When** the v2 `selfAnonymization` machinery
   (Phase A.0/A.1/A.2, the `restore*`/scrub functions, the Mitarbeiter-/Platz-/
   Person-pattern restorers) is removed, **Then** the suite stays green.
2. **Given** a passed cut-over, **When** the v3 stable-id code
   (`applyStableIdTokenization`, `applyStableIdPrepass`, `tokenForStableId`,
   `piiFields` annotations, the Odoo helpers) is removed, **Then** the suite
   stays green.
3. **Given** the removed v3 token-paraphrase failure mode, **When** the
   Output-Validator retry loop is reviewed, **Then** the now-redundant
   token-leak retry path is removed or simplified, with a note of what remains.
4. **Given** the adapted Privacy Receipt, **When** a turn completes, **Then**
   the receipt reports datasets interned, fields masked per classification, and
   verbs executed — not token counts.
5. **Given** the cleanup, **When** the tree is searched, **Then**
   `ensureWellFormedParams` (surrogate hardening) is still present and wired.

---

### Edge Cases

- **Empty tool result**: interned as a dataset with row count 0; the Digest
  reports `rowCount: 0`; verbs over it return empty results, never an error.
- **Result larger than the intern bound**: truncated at intern time
  (`MAX_OUTPUT_CHARS`-style limit, C4); the Digest flags the truncation so the
  LLM knows the dataset is partial.
- **All-sensitive result** (every field free text): the Digest carries only
  `rowCount`, schema, and per-field distinct counts; the LLM can still rank by
  count or operate over row handles via the Verb API.
- **Non-tabular result** (scalar, single object, deeply nested): interned and
  classified by key path; the Digest represents the shape without flattening it
  into rows.
- **LLM render directive over a `sensitive-masked` column**: allowed — the
  Materializer renders the real value into the channel output for the
  authorized user (G1 protects the LLM wire, not the end user).
- **LLM render directive with an unknown `datasetId` or column**: rejected by
  the Materializer with a precise error — never rendered as a guess.
- **Verb predicate over a `sensitive-masked` field**: rejected (FR-014); the LLM
  may only predicate over `safe-cleartext` fields and row handles.
- **Cross-turn follow-up referencing a prior `datasetId`**: the dataset was
  dropped at `finalizeTurn`; the tool is re-run and re-interned (C1).
- **Pseudonym collision**: the fake pool is drawn against the real-name set so a
  pseudonym can never equal a real different person's name (C5).
- **Classifier over-masks a genuinely safe field**: accepted failure mode —
  answer quality is slightly reduced, never a leak; corrected by tuning the
  allowlist, not treated as a defect class.
- **Free-text PII in the user's own inbound message**: masked by the same
  deny-by-default classifier before the message reaches the LLM (FR-022).
- **v4 flag on but a downstream phase incomplete**: the flag is not flipped on
  in production for an agent until the full US1–US6 chain is in place; in
  development the flag stays off in prod (FR-025).

## Requirements *(mandatory)*

### Functional Requirements

#### Confidentiality boundary (G1)

- **FR-001**: The system MUST intern every tool result through
  `internToolResult(toolName, rawResult)` before the result can influence any
  LLM-bound message; interning stores `{ rows, schema, provenance }` behind a
  `datasetId` and returns `{ datasetId, digest }`.
- **FR-002**: A raw tool result MUST NOT be serialized into any LLM-bound
  message — system prompt, message history, or `tool_result` block. The LLM
  receives only the `datasetId` and the Digest.
- **FR-003**: The Dataset Store MUST be turn-scoped; every interned dataset MUST
  be dropped at `finalizeTurn`.
- **FR-004**: Interning MUST bound dataset size at intern time using the
  existing `MAX_OUTPUT_CHARS`-style limit and MUST record truncation in the
  Digest when it occurs.

#### Shape Classifier (deny-by-default)

- **FR-005**: The Shape Classifier MUST classify every field of an interned
  result by key path, using JSON shape and per-column value statistics only —
  no domain-, tool-, or schema-specific knowledge.
- **FR-006**: A field MUST be classified `safe-cleartext` only when it matches
  the explicit allowlist: numeric, boolean, ISO-8601 date/datetime,
  low-cardinality enum/categorical string, or opaque identifier treated as a
  pseudonymous row handle.
- **FR-007**: Every field not matching the `safe-cleartext` allowlist — all free
  text, every high-cardinality or unique-per-row string, every unrecognized
  field or shape — MUST be classified `sensitive-masked`.
- **FR-008**: An unknown or unrecognized field MUST default to
  `sensitive-masked` — over-masked, never leaked.
- **FR-009**: The Presidio NER detector MUST act only as a one-way booster: a
  detector hit on a value MUST force `sensitive-masked`; the absence of a hit
  MUST NOT promote any field to `safe-cleartext`.

#### Digest

- **FR-010**: The Digest MUST contain only `datasetId`, row count, schema (field
  name + type + classification), `safe-cleartext` values or summaries, and for
  each `sensitive-masked` field a placeholder plus a distinct-value count — and
  MUST contain no identity-bearing value.

#### Verb API (G2)

- **FR-011**: The system MUST provide a server-side Verb API —
  `filter`, `sort`, `group`, `aggregate`, `top_n`, `select`, `count`, `join` —
  operating on a `datasetId` and returning a new `datasetId` + Digest.
- **FR-012**: Verbs MUST be composable: the output `datasetId` of one verb is a
  valid input to any other verb.
- **FR-013**: Identity- and order-critical operations (sort, rank, group,
  aggregate, filter, join) MUST execute in trusted server code against the real
  dataset; the LLM MUST NOT execute them — it only composes verb calls.
- **FR-014**: Verb predicates MUST range only over `safe-cleartext` fields and
  pseudonymous row handles; a predicate referencing a `sensitive-masked` field
  MUST be rejected with a precise error.
- **FR-015**: The `filter` predicate language MUST be a bounded, safe
  expression grammar — no arbitrary code execution.

#### Materializer

- **FR-016**: The final answer MUST be rendered server-side by the Materializer
  from the real dataset produced by the verb chain; the LLM emits PII-free prose
  plus a render directive `{ datasetId, columns, format }`.
- **FR-017**: Real identity values MUST appear only in the channel-bound output
  delivered to the authenticated internal user; they MUST NOT pass back through
  the LLM.
- **FR-018**: The Materializer MUST reuse the existing `routineTemplateRenderer`,
  generalized from pre-defined routines to ad-hoc render directives, without
  breaking the existing routine path.
- **FR-019**: The Materializer MUST reject a render directive referencing an
  unknown `datasetId` or a non-existent column rather than render a guess.

#### Pseudonym Projection

- **FR-020**: For prose that must reason about specific individuals, the system
  MUST provide a Pseudonym Projection in which `sensitive-masked` fields are
  replaced by stable, realistic pseudonyms drawn through the same
  deny-by-default filter; the pseudonym↔real map MUST be held server-side.
- **FR-021**: A generated pseudonym MUST NOT equal any real value in the
  dataset's real-name set, and MUST be stable for the same individual within a
  turn.
- **FR-022**: Pseudonym Projection MUST be an optional, gated layer — off unless
  an operation explicitly requires individual-level prose.

#### Inbound user PII

- **FR-023**: Free-text PII in the user's own inbound chat message MUST be
  masked by the same deny-by-default classifier before the message reaches the
  LLM.

#### Proof and genericity

- **FR-024**: The system MUST provide an automated on-the-wire test harness that
  inspects every LLM-bound payload (system prompt + messages + `tool_result`s)
  and asserts zero identity values appear.
- **FR-025**: v4 behaviour MUST require zero per-tool annotation: a freshly
  added plugin's tool output is interned and deny-by-default classified by
  construction.

#### Rollout and observability

- **FR-026**: The entire v4 path MUST be controlled by a feature flag; with the
  flag off, the existing v2/v3 path runs unchanged and no v4 behaviour is
  observable.
- **FR-027**: After the HR agent cut-over (US8) passes acceptance, the v2
  `selfAnonymization` machinery and v3 stable-id tokenization MUST be removed;
  `ensureWellFormedParams` (surrogate hardening) MUST be retained.
- **FR-028**: The Privacy Receipt MUST be adapted to report datasets interned,
  fields masked per classification, and verbs executed — instead of token
  counts.
- **FR-029**: Interning, classification verdicts, verb execution, and
  materialization MUST emit structured logs carrying enough context (turn id,
  `datasetId`, tool name) to reconstruct a turn.

### Key Entities

- **Dataset**: a turn-scoped, server-held tool result — `datasetId`, real
  `rows`, `schema`, and `provenance` (originating tool, turn, timestamp). Never
  leaves the server.
- **Dataset Store**: the turn-scoped, in-memory registry of Datasets; interns
  results, resolves `datasetId`s, and drops everything at `finalizeTurn`.
- **Field Classification**: the per-field verdict `safe-cleartext` or
  `sensitive-masked`, with the JSON type and the value statistics that produced
  it.
- **Dataset Schema**: the list of fields with name, type, classification, and
  cardinality — identity-free, safe to show the LLM.
- **Digest**: the identity-free stand-in the LLM receives for a Dataset —
  `datasetId`, row count, schema, `safe-cleartext` values/summaries, and
  per-masked-field placeholder + distinct count.
- **Verb**: a server-side operation (`filter`, `sort`, `group`, `aggregate`,
  `top_n`, `select`, `count`, `join`) over a `datasetId`, producing a new
  `datasetId` + Digest.
- **Render Directive**: the LLM's instruction to the Materializer —
  `{ datasetId, columns, format }`.
- **Pseudonym Projection / Pseudonym Map**: a Dataset variant whose
  `sensitive-masked` fields carry stable realistic pseudonyms, plus the
  server-held pseudonym↔real map.
- **Privacy Receipt**: the per-turn user-facing report, adapted to v4 — datasets
  interned, fields masked per classification, verbs executed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For "Wer hat dieses Jahr den meisten Urlaub?", the user-visible
  answer shows real, complete employee names — zero tokens, zero partial names,
  zero invented labels.
- **SC-002**: For the same answer, ranks are correct, with no duplicated and no
  invented people.
- **SC-003**: An automated on-the-wire test asserts zero identity values appear
  in any LLM-bound payload (system prompt + messages + `tool_result`s) for the
  HR-Urlaubsranking turn.
- **SC-004**: A newly added tool/plugin with zero privacy-specific annotation
  has its output interned and deny-by-default classified — verified by a test
  using a fresh, never-before-seen fixture shape.
- **SC-005**: 100% of fields the classifier does not positively recognize as
  safe are masked — measured across a multi-shape fixture set; no unrecognized
  field reaches the LLM in cleartext.
- **SC-006**: The Digest carries no identity-bearing value for any shape in the
  fixture set — verified by the on-the-wire harness.
- **SC-007**: A verb chain (e.g. `sort` → `top_n`) produces ranking output
  identical to a trusted reference computation over the raw dataset.
- **SC-008**: A Digest's size depends on row count and schema, not on row
  content length — a 500-row result and a 5-row result of the same schema
  produce digests within a bounded size ratio.
- **SC-009**: With the feature flag off, the full existing middleware test suite
  stays green — the v2/v3 path is unchanged.
- **SC-010**: After cut-over, the v2 `selfAnonymization` machinery and v3
  stable-id code are removed and the full suite plus a boot smoke test stay
  green.

## Assumptions

- The authenticated internal user is authorized to see real PII in the final
  channel output; v4 protects the LLM wire, not the user-facing answer.
- Tool results are JSON-serializable — consistent with the existing
  tool-dispatch contract.
- The existing Presidio detector sidecar remains available and is repurposed as
  a value-level booster for the Shape Classifier.
- The `routineTemplateRenderer` deterministic renderer is suitable to generalize
  as the Materializer.
- Turn-scoped dataset lifetime is sufficient for v1; cross-turn dataset reuse is
  deferred (C1).
- Verbs are exposed to the LLM as individual tool calls, not a mini-DSL, for v1
  (C2).
- The HR agent and its "Wer hat dieses Jahr den meisten Urlaub?" case are the
  acceptance vehicle; other agents are cut over afterwards.
- v3 work merged in `omadia` PR #86 and `omadia-byte5-plugins` PR #1 stays
  additive-inactive until US9; no further fixes go into the v2/v3 line.
- The amount of genuine free-form per-person reasoning the Pseudonym Projection
  must support is scoped from real transcripts before US7 is built (C6).

## Traceability — Handoff §8 issue mapping

This spec realizes the GitHub-issue backlog in
`docs/harness-platform/HANDOFF-2026-05-21-privacy-shield-v4-data-plane-boundary.md`.

| User Story | Handoff issue |
|---|---|
| US1 Dataset Store | #v4-1 |
| US2 Shape Classifier | #v4-2 |
| US3 Digest + tool-dispatch wiring | #v4-3 |
| US4 On-the-wire confidentiality harness | #v4-7 |
| US5 Verb API | #v4-4 |
| US6 Materializer | #v4-5 |
| US7 Pseudonym Projection | #v4-6 |
| US8 HR cut-over + acceptance run | #v4-8 |
| US9 Cleanup — remove v2/v3 | #v4-9 |
