# Research & Design Decisions: Privacy Shield v4 — Data-Plane Boundary

Phase 0 output. Records the design forks evaluated and resolved while shaping
this feature, plus the root-cause analysis that retired v2/v3, so implementers
do not re-litigate them.

## Root cause — why v2/v3 are a dead end

Every prior version is **blocklist thinking**: data flows to the LLM by default
and the system tries to *detect* PII and tokenize it out (detect-then-allow).
Two unfixable consequences:

1. **Detection is never complete.** Presidio NER misses German surnames
   ("Marvin" → `«PERSON_5»`, "Vomberg" leaks). Annotations (`piiFields`,
   stable-id) are reliable but per-tool and Odoo-scoped — not generic. Any field
   the detector misses leaks verbatim.
2. **The LLM is kept in the data path with a blindfold.** A `«PERSON_N»` token
   is a fragile foreign object with no semantic anchor. The model paraphrases it
   ("Mitarbeiter 1", "Platz 1"), hallucinates counters (`«PERSON_99»`), drops
   tokens in aggregates, and — even with stable-id — places the right name in
   the wrong row. Restoration then guesses positionally and is silently wrong.

The failure of record is the HR-Urlaubsranking screenshot (2026-05-18): partial
names (`«PERSON_53» Rüsche`), invented labels ("Goerres (2. Person)", "Platz N"),
wrong ranks. The entire `selfAnonymization` machinery exists only to paper over
token fragility — and still does not work. **Privacy and answer-quality have the
same root cause: the LLM processes identity-bearing rows.** The fix is not a
better blindfold; it is to take the LLM out of the data path.

## D1 — Invert the default: deny-by-default boundary vs. detect-then-allow

**Decision**: Nothing flows to the LLM unless proven safe. A raw tool result is
interned server-side; the LLM receives only an identity-free Digest. "Critical
data never reaches the LLM" becomes a *structural property of the boundary*, not
an outcome of detection quality.

**Rationale**: Allowlisting "safe" is tractable and reliable; blocklisting "PII"
is not (root cause #1). The failure mode flips: an unknown field is
*over-masked* (safe), never *leaked* (the v2/v3 bug).

**Rejected**: Continue patching v2/v3 detection — chases NER recall forever and
never closes the gap for unseen tools.

## D2 — Take the LLM out of the data path: compose-not-execute

**Decision**: Identity- and order-critical operations (sort, rank, group,
aggregate, filter, join) run in trusted server code via the Verb API. The LLM
*composes* verb calls; it does not *execute* them. The final answer is joined
against ground truth, never trusted from the LLM's output.

**Rationale**: This is root cause #2's fix and the second half of the
quality/privacy unification — the LLM can no longer mis-rank, drop, or
paraphrase identity rows because it never holds them.

**Rejected**: Keep the LLM ranking rows but with better tokens — the v3
attempt; stable-id already proved tokens are mis-placed positionally.

## D3 — Classification: allowlist `safe-cleartext` vs. blocklist PII

**Decision**: The Shape Classifier allowlists `safe-cleartext` —
numbers, booleans, ISO-8601 dates, low-cardinality enums/categoricals, opaque
IDs as row handles. **Everything else** is `sensitive-masked`: all free text,
every high-cardinality / unique-per-row string, every unrecognized field. The
classifier uses JSON shape + per-column value statistics only — never domain
knowledge — so it stays generic across every current and future tool.

**Rationale**: A finite, enumerable allowlist of structurally-safe shapes is
verifiable; the space of "all PII" is not. Genericity (the requirement that
killed v3) holds by construction.

**Rejected**: A domain-aware classifier that knows Odoo/Confluence/M365 shapes —
reintroduces the per-tool maintenance burden v3 died of.

## D4 — Presidio demoted to a one-way booster

**Decision**: The Presidio detector is kept, but only as a *secondary booster*
inside the Shape Classifier: an NER hit on a value forces `sensitive-masked`;
the *absence* of a hit never grants `safe-cleartext`.

**Rationale**: Presidio's recall is too low to be a gate (root cause #1) but its
precision is useful — a positive hit is real signal. One-way use keeps the
benefit without letting a miss become a leak.

**Rejected**: Drop Presidio entirely — discards usable precision. Keep Presidio
as a gate — the v2/v3 mistake.

## D5 — Materializer: reuse `routineTemplateRenderer` vs. a new renderer

**Decision**: The Materializer is a generalization of the existing
`middleware/src/plugins/routines/routineTemplateRenderer.ts`, extended from
pre-defined routine templates to ad-hoc render directives
(`{ datasetId, columns, format }`).

**Rationale**: That renderer already renders deterministic tables from raw data
server-side — exactly the Materializer's job. Reuse keeps one rendering code
path and inherits the routine path's existing tests.

**Rejected**: A fresh renderer — duplicates deterministic-rendering logic and
splits the table-rendering surface in two.

## D6 — Dataset Store lifecycle: turn-scoped, in-memory

**Decision**: The Dataset Store is in-memory and turn-scoped — datasets are
dropped at `finalizeTurn`, mirroring the v2 tokenize-map lifecycle. No database.
Size is bounded at intern time by the existing `MAX_OUTPUT_CHARS`-style limit.

**Rationale**: The tokenize-map lifecycle is a proven fit for per-turn privacy
state; reusing its shape avoids inventing a new persistence story. A DB would
add a schema, migrations, and a cleanup job for data that lives seconds.

**Rejected**: Session- or persistently-scoped store — see C1; deferred.

## D7 — Verb composition surface: individual tool calls vs. a mini-DSL

**Decision**: Verbs are exposed to the LLM as **individual tool calls** for v1.

**Rationale**: Each tool call is independently schema-validated by the existing
tool-use machinery — no grammar to write or parse, and a malformed verb fails
like any bad tool call. A single-payload mini-DSL would cut round-trips but
needs its own parser and validator.

**Rejected for now**: A mini-DSL the LLM emits in one shot — a fair latency
optimization, revisit once verb-call chains prove long in practice.

## D8 — Pseudonym Projection as an optional gated layer

**Decision**: Pseudonym Projection — `sensitive-masked` fields replaced by
stable realistic pseudonyms, server-held pseudonym↔real map — is an **optional,
gated** layer, not the primary mechanism. It is released only when an operation
genuinely needs per-person prose.

**Rationale**: The earlier "pseudonyms beat tokens" idea is correct but narrow:
most answers (rankings, aggregates, tables) are served by the Verb API +
Materializer without naming a person to the LLM at all. Demoting pseudonyms to a
gated fallback keeps the common path identity-free and reserves pseudonyms for
the rare free-form case.

**Rejected**: Pseudonyms as the primary mechanism — would route identity-shaped
(if fake) data through the LLM on every turn, a larger attack surface than
needed.

## D9 — Where the v4 contract types live

**Decision**: The v4 logic and its contract types (`Dataset`, `Digest`, `Verb`,
`RenderDirective`, the `internToolResult` signature) live in the existing
`harness-plugin-privacy-guard` package, exported from its `index.ts`. The
orchestrator consumes them through the existing `privacyHandle` capability seam.

**Rationale**: privacy-guard already owns the privacy capability; v4 has exactly
one consumer. A new package would be organisational-only (Constitution: no
organisational-only libraries). Because the types are exported from one owning
package and imported — never re-declared — Constitution II (contract-first) is
satisfied without a `plugin-api` entry.

## Out of scope — unchanged or consumed from elsewhere

- **`ensureWellFormedParams`** (outbound surrogate hardening, `omadia` PR #118):
  fully orthogonal to the data-plane boundary. Stays exactly as-is; US9
  explicitly verifies it survives the cleanup.
- **Per-record / per-user authorization**: unchanged. v4 protects the LLM wire;
  who may see PII in the final answer is an existing, separate concern.

## Clarifications — resolved 2026-05-21

### C1 — Cross-turn dataset lifecycle (affects US1, FR-003)

**Decision**: Turn-scoped for v1. Every interned dataset is dropped at
`finalizeTurn`. A follow-up question that needs an earlier result re-runs the
tool and re-interns.

**Rationale**: Turn-scoped state has a trivial, leak-proof lifecycle (it cannot
outlive its turn). Re-running a tool is cheap relative to designing a
session-scoped store with its own eviction and staleness policy before there is
evidence follow-ups need it.

**Rejected for now**: Session-scoped store — revisit if transcripts show
frequent follow-ups re-querying the same dataset.

### C2 — Verb composition surface (affects US5, FR-011)

**Decision**: Individual tool calls (see D7).

### C3 — `filter` predicate language (affects US5, FR-014, FR-015)

**Decision**: A bounded, safe expression grammar over `safe-cleartext` fields
and pseudonymous row handles only. Comparison operators (`eq`, `ne`, `lt`,
`lte`, `gt`, `gte`, `in`, `between`) and boolean combinators (`and`, `or`,
`not`); no arbitrary code, no string operations over `sensitive-masked` fields.
Full grammar in `contracts/verb-api.md`.

**Rationale**: A closed operator set is statically validatable and cannot become
a code-execution or exfiltration surface. Predicates over masked fields are
forbidden because they would let the LLM probe identity values by binary search.

### C4 — Dataset Store memory bound (affects US1, FR-004)

**Decision**: Reuse the existing `MAX_OUTPUT_CHARS`-style limit, applied at
intern time. A result exceeding the bound is truncated; the Digest records the
truncation so the LLM knows the dataset is partial.

**Rationale**: The bound already exists for tool output; applying it at intern
time keeps one limit, one place. Truncation is surfaced rather than silent so
the LLM does not reason over a dataset it believes is complete.

### C5 — Pseudonym collision (affects US7, FR-021)

**Decision**: The fake-name pool is drawn against the dataset's real-name set —
a generated pseudonym is rejected if it equals any real value present.
Pseudonyms are stable per individual within a turn.

**Rationale**: A pseudonym that happens to equal a real different person's name
would be a silent mis-attribution — worse than a token. Drawing against the real
set closes it deterministically.

### C6 — Individual-reasoning coverage (affects US7)

**Status**: [NEEDS CLARIFICATION] — how much genuine free-form reasoning over
specific individuals the Pseudonym Projection must support is **not yet pinned
down**. It MUST be scoped from real HR/agent transcripts before US7 is built, so
the projection is sized to actual demand and not over-built. US7 is P2
specifically so this scoping can happen after the P1 chain proves the boundary.

### C7 — Inbound user PII (affects US8, FR-023) — resolved post-spec

**Decision**: The user's own chat message is **user-disclosed input** and is
NOT masked. The data-plane boundary governs *tool results* — data the LLM must
not process — not what the user themselves typed and already knows. When a user
names a person, that name reaches the tool's input directly so the tool can
resolve the entity; the tool's *result* is interned + digested as usual.

**Rationale**: v2 tokenized the inbound message mainly for intra-turn token
coherence with tool results — a need v4 does not have (v4 never tokenizes tool
results). Masking the user's own input would also break tool resolution (the
tool needs the real name) without a reversible-restore mechanism, which v4
deliberately drops. FR-023's draft "mask inbound user PII" is therefore
superseded — no v4-native inbound masker is built.

**Rejected**: a minimal v4 tokenize-restore kept only for user→tool input —
re-introduces the v2 token machinery US9 exists to remove, for a case (the user
disclosing data they already hold) that is not the threat model.

### C8 — US9 deletion timing — resolved post-spec

**Decision**: The v2/v3 deletion (US9) runs **after** the intensive live test,
not before. Until then v4 (flag on) and v2/v3 (flag off) coexist.

**Rationale**: v4's LLM-loop behaviour is not yet live-verified. Keeping v2/v3
in place during the test preserves a working A/B baseline; if the test finds a
v4 loop bug, the prior behaviour is still runnable for comparison. The deletion
is pure debt-removal and loses nothing by waiting.
