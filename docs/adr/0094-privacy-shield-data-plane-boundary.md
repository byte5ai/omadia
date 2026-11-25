# 0094 — Privacy Shield: tool results stay behind a data-plane boundary, the model works on a digest

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  implemented in #119 (Privacy Shield v4), follow-ups #126, #153, #242, #431, #1402.
- **Supersedes:** —

## Context and Problem Statement

Agents read business records (Odoo rows, calendar entries, uploaded tables) through tools,
and a tool result normally becomes part of the next model request. Earlier slices masked
that text on the wire: an NER sidecar (Presidio + spaCy) tokenised names into `«TYPE_N»`
tokens and a restore pass mapped them back. `plugin-api/src/piiAnnotation.ts` keeps the
failure modes on record: partial-name leaks (`«PERSON_53» Vomberg`), counter drift (one
employee under two tokens in one result) and false-positive cascades ("Krankheit" tagged
as an address).

How does personal data from a data source stay out of a model request without depending
on a probabilistic detector? This record is written retroactively; the decision is
implemented in `@omadia/plugin-privacy-guard`.

## Decision Drivers

- Masking must not depend on a detector finding every name.
- Identity- and order-critical work (filter, sort, join, count) must still be exact.
- The answer the user reads must carry the real values.
- One implementation, generic over JSON shape, no per-tenant tuning.

## Considered Options

- **A — Data-plane boundary:** intern the raw result server-side, give the model an
  identity-free digest, run data operations as server-side verbs, materialize the answer
  from the real rows.
- **B — On-wire tokenisation with restore** (detector finds PII in the serialised result,
  tokens cross the wire, a response pass restores them).
- **C — Tool-side annotations only** (each tool declares its PII fields; stable-id tokens).

## Decision Outcome

Chosen option: **A**. The provider publishes `privacy.redact@1`; the orchestrator's
dispatch seams call it for every tool result of a turn.

- **Intern.** `internToolResultV4` stores the raw rows in a per-turn dataset store
  (`v4/datasetStore.ts`). The state is turn-scoped and dropped in `finalizeTurn`.
- **Digest.** The model gets a shape-classified digest (`v4/digest.ts`,
  `v4/shapeClassifier.ts`). A field is either `safe-cleartext` or `sensitive-masked`;
  only the types `number`, `boolean`, `date`, `enum`, `id` and `label` may ever be clear,
  and an unknown type is masked. The C0 identity types (e-mail, IBAN, phone, address, id
  number) act as a one-way booster: they can only add masking.
- **Verbs.** `v4_filter`, `v4_sort`, `v4_top_n`, `v4_select`, `v4_distinct`, `v4_group`,
  `v4_aggregate`, `v4_count`, `v4_join` and `v4_union` run against the real rows
  server-side. A derived dataset is classified again, and there is no control-flow
  exemption in the classifier.
- **Render.** `v4_render_answer` materializes the answer from ground truth
  (`v4/materializer.ts`). A `format: table` render returns the model a shape
  acknowledgement only (row count, the column labels it chose); the real cells go to the
  kernel's canvas-sentinel sink as `PrivacyV4ToolResult.canvasSentinel` and never into a
  `tool_result` (#1402, plugin-api 1.33.0, `v4RenderSideChannel.ts`).
- **No second path.** The on-wire token map, its restore pass and the Presidio sidecar are
  removed (#119, #126, #153, #242). `src/service.ts` plus `src/v4/` is the single
  implementation (#431). The boundary itself has no configuration.
- **Fail closed.** A result whose interning throws does not reach the model; every
  interning seam hands out the kernel's `internFailedNotice` instead.

### Consequences

- 🟢 **Good:** A name the detector would have missed never crosses the wire in a tool
  result, because no detector decides it.
- 🟢 **Good:** Figures in answers come from the rows, not from the model's reading of them.
- 🔴 **Bad:** The model cannot read free text in a result; document-shaped sources need the
  operator bypass ([ADR-0092](0092-privacy-postures-bypass-and-org-clamp.md)).
- 🔴 **Bad:** The agent's own infrastructure tools had to be exempted by a fixed allowlist
  (`INTERN_EXEMPT_TOOLS`: `memory`, the stored-process tools, `suggest_follow_ups`,
  `ask_user_choice`, `read_attachment`), each a place where a result reaches the model as
  returned.
- 🔴 **Bad (accepted residual):** the boundary covers a turn's own model requests. The
  subscription-CLI runtime and a plugin's `ctx.llm` request are outside it
  (`docs/security-architecture.md` §3a, §6f).
- ⚪ **Neutral:** The `v4/` directory name is kept on purpose as the engine namespace.

## Pros and Cons of the Options

### A — Data-plane boundary

- 🟢 Deterministic; correctness of joins and sums does not depend on masking.
- 🔴 More machinery: dataset store, verb API, materializer, extra tool rounds.

### B — On-wire tokenisation with restore

- 🟢 The model reads the full text, only tokens replaced.
- 🔴 The three recorded failure modes; removed for cause.

### C — Tool-side annotations only

- 🟢 Precise where a tool knows its stable ids.
- 🔴 Covers only tools that declare them; kept as an additive layer
  (`ToolRegistrationOptions.piiFields`, `v4/declaredPii.ts`), not as the boundary.

## More Information

- Related: [ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md)
  (side channel for data), [ADR-0019](0019-discretion-as-information-flow-control.md),
  [ADR-0095](0095-prompt-masking-wire-substitution-fail-closed.md), [ADR-0078](0078-tool-errors-reach-the-model-by-provenance.md).
- Code: `middleware/packages/harness-plugin-privacy-guard/` (`README.md`, `src/service.ts`,
  `src/v4/`), `middleware/packages/harness-orchestrator/src/privacyInternPolicy.ts`,
  `v4RenderSideChannel.ts`; `docs/security-architecture.md` §6, §6f.
- Tests: `middleware/test/privacyV4*.test.ts`, `privacyInternPolicy.test.ts`,
  `test/orchestrator/internFailureFailsClosed.test.ts`.
