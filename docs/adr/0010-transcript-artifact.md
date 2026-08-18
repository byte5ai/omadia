# 0010 — Transcript Artifact: canonical raw record with a derived masked projection

## Status

Proposed

- **Date:** 2026-08-18
- **Deciders:** maintainer (A. Derjagin), agent-assisted design session for #584
- **Supersedes:** —

## Context and Problem Statement

The transcription capability (#584, applying the capability pattern of
[ADR-0003](0003-capability-based-multi-provider-middleware.md)) turns a
recorded meeting into knowledge. A recording has N speakers, but the session
substrate is strictly two-role (User/Assistant) and `TurnIngest` has no
speaker field; the issue additionally demands that persisted transcripts be
speaker-attributed and *proof-ready*, while all ingested content must pass
the platform's masking discipline before reaching the knowledge graph or any
LLM. Where does the authoritative, speaker-attributed transcript live, and
how does it enter recall — without breaking the two-role model or the
privacy contract?

Transport context (relevant trade-off resolved alongside): the OpenAI
adapter uses the `openai` SDK for both batch and realtime surfaces, housed
in one adapter package. A fetch-based transport was rejected — batch
transcription is multipart upload plus streamed deltas plus retry
classification, and the supposed SSRF-guard benefit of fetch was verified
void (the guard only covers plugin `ctx.http` in public-web mode; egress
runs under the same operator-trust posture as the LLM and embedding
adapters).

## Decision Drivers

- Proof-readiness: a future proof feature must be able to attest what was
  actually said — attribution may not be lossy or stringly-typed.
- Privacy contract: everything wire-, graph-, or LLM-facing must be masked;
  a proof-faithful record cannot be.
- Blast radius: the session markdown → parser → graph-backfill replay path
  and all KG backends should keep working unchanged.
- The capability is provider-neutral; no v1 provider emits speaker labels,
  but future diarizing providers must slot in without contract churn.

## Considered Options

- **A — Transcript Artifact + derived projection**: canonical raw,
  speaker-attributed artifact in the blob store; masked chunk projection
  into session turns for recall.
- **B — Speaker-prefix only**: encode speakers as text prefixes in ordinary
  session turns; no separate artifact.
- **C — Extend the turn model**: new `entryType` or a `TurnIngest` format
  extension carrying speaker structure.

## Decision Outcome

Chosen option: **A**, because it is the only option that satisfies proof and
privacy at once: the artifact is the single source of truth (raw, faithful,
speaker-attributed), and everything derived from it is masked and
disposable. B makes attribution stringly-typed and unprovable. C conflates
the capture-classification axis with speaker structure (new `entryType`) or
touches renderer, parser, backfill, and every KG backend (`TurnIngest`
extension) for what is only a projection concern.

Concretely:

- **Transcript Artifact** (canonical, proof-ready): JSON in the blob store,
  **unmasked** — proof must be faithful to the audio; the store's access
  guard is the privacy boundary, and artifact content never goes to wire or
  LLM. Segments carry a diarization **Speaker Label** as canonical
  attribution (default-assigned when the provider attributes nothing; an
  optional resolved-person mapping may be added later but never replaces
  the label), optional timestamps, and a declared **Timing Provenance**
  (`provider | estimated | none` — no v1 model returns timestamps; honesty
  over invention). Metadata: recording identity, recording start, uploader.
  Re-ingesting an existing recording is a no-op/error (no re-transcription
  versioning in v1).
- **Derived chunk projection** (recall): segments grouped into chunks at
  segment boundaries, one chunk = one two-role session turn via the shared
  session-logger path (speaker-prefixed lines in the user message, empty
  assistant answer, per-recording scope, time derived from recording
  start). **Masked before logging** — markdown, knowledge graph, and every
  LLM-facing path see masked text only. The projection is disposable and
  rebuildable from the artifact.
- **Proof-readiness = documented invariants, not a hash field**: segments
  are append-only, ids stable, a segment never mutates once completed,
  everything plain-JSON serialisable. A hash field today would be
  speculative contract surface with no consumer (Proof implementation is
  explicitly out of scope for #584's Step 2).

### Consequences

- 🟢 **Good:** two-role session model, replay path, and KG backends remain
  untouched; the projection rides existing machinery.
- 🟢 **Good:** attribution-neutral contract — a diarizing provider later
  fills the Speaker Label slot without any schema change.
- 🟢 **Good:** privacy placement is unambiguous: raw only behind the blob
  store's access guard; masked everywhere else.
- 🔴 **Bad:** PII-bearing transcripts are stored **unmasked** in the blob
  store by design — surprising without this record; the store's access
  control becomes load-bearing for privacy.
- 🔴 **Bad:** recall quality is bounded by the projection (chunking,
  masking); answering "who exactly said what, verbatim" requires artifact
  access, which no LLM path has.
- ⚪ **Neutral:** re-transcription versioning and per-segment hashing are
  deferred; the documented invariants keep both possible without migration.
- ⚪ **Neutral:** the operator-trust egress posture of provider adapters
  (unguarded outbound to a configured base URL) is documented in the #584
  spec and remains an ADR candidate for a separate, system-wide effort.

## Pros and Cons of the Options

### A — Transcript Artifact + derived projection

- 🟢 Proof and privacy both satisfied; single source of truth.
- 🟢 Zero change to the turn model and replay machinery.
- 🔴 Two representations to keep conceptually distinct (artifact ≠
  capability transcript ≠ chunk).

### B — Speaker-prefix only

- 🟢 Smallest possible build.
- 🔴 Attribution is parseable text at best — fails proof-readiness.
- 🔴 Masking would destroy the only copy of the faithful transcript.

### C — Extend the turn model

- 🟢 Speakers become first-class in recall.
- 🔴 High blast radius (renderer, parser, backfill, all KG backends).
- 🔴 Conflates capture classification with speaker structure; still needs a
  raw record somewhere for proof.
