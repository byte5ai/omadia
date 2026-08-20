# 0010 — Adopting the Lume icon + state-as-glyph specs into core

## Status

Accepted

- **Date:** 2026-08-17
- **Deciders:** Canvas / Tier-2 maintainers
- **Supersedes:** —

## Context and Problem Statement

The Lume specs in `byte5ai/omadia-ui` were updated (omadia-ui#41 iconography,
omadia-ui#42 state-as-glyph) and merged to `omadia-ui:main`. They propose, as an
*additive* canvas-protocol §12 v1.1 change: an `icon` trait carrying a namespaced
`IconRef` (`app:` / `lib:` / `gen:`), an `iconResolver@1` renderer feature, a
deferred `iconGenerator@1`, and a compact "spark" chart variant, plus the authoring
principle "show state, don't narrate it". None of this had landed in core
(verified against `main@1e5b24d`: zero occurrences of `IconRef`, `iconResolver`,
`iconGenerator`, an icon trait, or a spark chart variant). The upstream docs
themselves say "proposal / RFC … not yet merged into either canonical spec".

The question: **do we adopt these additive protocol changes now, and if so which
parts — given the Tier-1 renderer lives in a different repo and rejects unknown
props wholesale?**

## Decision Drivers

- The canvas tree is validated by a **strict whitelist** (`unevaluatedProperties:false`).
  A half-shipped prop is not degraded gracefully — the whole surface is rejected.
- The Tier-1 renderer that consumes icons lives in `byte5ai/omadia-ui`, not this
  repo's `web-ui/`. Core cannot assume it supports icons yet.
- The upstream specs are still RFC; we want to move without committing to churn
  (naming, versioning) we would have to unwind.
- `app:`/`lib:` icon refs are safe; `gen:` implies sanitised-SVG handling and consent
  semantics (upstream §6) that need a security review before enabling. The schema is the
  last gate before a renderer, so the deferral is enforced *there*: the `icon` pattern
  accepts only `app:`/`lib:` today and `gen:` is rejected until that review lands — not
  merely left un-emitted.

## Considered Options

- **A — Adopt the additive-safe subset now, gate-ready.** Land the vocabulary
  (`icon`/`iconState`, chart `variant:"spark"`) + validator tests + the
  state-as-glyph authoring rule on *existing* primitives; do not enable new-prop
  emission until the renderer negotiates `iconResolver@1`. Defer `gen:` and
  `iconGenerator@1`.
- **B — Full adoption now.** Also plumb `clientFeatures` from `handshake_select`
  through the channel into the orchestrator and gate icon/spark emission on
  `iconResolver@1`, turning icon authoring on immediately.
- **C — Wait for spec canonization.** Do nothing in core until the upstream spec
  is no longer RFC.

## Decision Outcome

Chosen option: **A**, because it is purely additive and cannot brick any surface —
the schema accepts the new vocabulary but nothing in core *emits* it yet, so no
tree carrying an unknown prop reaches an old renderer. It records the naming and
versioning decisions (below) now, so nothing churns, while leaving the actual
emission behind the `iconResolver@1` handshake gate as a scoped follow-up.

### Consequences

- 🟢 **Good:** `canvas-tree` validates icon/iconState/spark; the desktop and mobile
  renderers now have one contract to build against (exercised by `_gallery.json`).
- 🟢 **Good:** The cheap, high-leverage half — "show state, don't narrate it" — ships
  immediately using `status`+`tone` / `progress` / `chart`, which need no protocol
  change.
- 🟢 **Good:** No naming churn: `iconGenerator@1` is pinned to `generateAsset`
  scope `{kind:"icon"}`, not a new capability enum value.
- 🔴 **Bad:** The `icon`/`spark` vocabulary is schema-ready but not yet emitted —
  a deliberate, documented gap, not an oversight. Turning it on requires the gate.
- ⚪ **Neutral (follow-up):** Plumb `clientFeatures` (handshake → orchestrator) and
  gate icon/spark emission on `iconResolver@1`; then add the `app:` curated-subset
  + icon-placement authoring rules. Separately, security-review the `gen:` prefix
  (sanitised SVG + consent); it stays rejected by the `icon` pattern until then, and the
  pattern widens to include it in that same PR.

### Version story

`canvas-tree.schema.json` keeps its `$id` at `…/protocol/1.0/…`. The traits are the
additive 1.1-*proposed* vocabulary carried inside the 1.0 whitelist. Bumping the
`$id` to 1.1 was rejected: the change is purely additive, and a bump would force a
sweep of every cross-schema `$ref` for no behavioural gain. Documented in the
`icon` trait `description`.

## Pros and Cons of the Options

### A — Additive-safe subset, gate-ready

- 🟢 Zero brick risk: schema accepts, nobody emits.
- 🟢 Every claim is empirically verifiable (validator tests + fixture read-back).
- 🔴 Leaves emission for a follow-up; `icon`/`spark` are inert until gated.

### B — Full adoption now

- 🟢 Meets the "emit only when `iconResolver@1`" criterion literally, today.
- 🔴 Touches the channel↔orchestrator boundary (features are parsed at the wire
  today but never forwarded to Tier 2) — a bigger, cross-cutting change while the
  upstream spec is still RFC.

### C — Wait for canonization

- 🟢 No core change at all.
- 🔴 The renderers keep diverging from core with no shared contract; the free,
  no-protocol half (state-as-glyph) is needlessly delayed.

## More Information

- Upstream specs: `byte5ai/omadia-ui` → `docs/iconography.md`, `docs/data-glyphs.md`,
  `docs/protocol/1.0.md` §12 (omadia-ui#41, omadia-ui#42).
- Implementation: `middleware/packages/canvas-core/schema/canvas-tree.schema.json`
  (`icon`/`iconState` on `commonTraits`, `variant` on `p_chart`),
  `capability-manifest.schema.json` (`generateAsset {kind:"icon"}` note),
  `test/validator.test.ts`, `fixtures/_gallery.json`, and the state-as-glyph rule in
  `omadia-ui-orchestrator/src/composition.ts`.
- Tracking issue: #343.
