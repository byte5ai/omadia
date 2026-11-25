# 0095 — Free text is masked by wire substitution with server-side restore, and fails closed

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  implemented in #361 / #481, refined in #1528, #1529, #1541, #1544, #1547.
- **Supersedes:** —

## Context and Problem Statement

The data-plane boundary ([ADR-0094](0094-privacy-shield-data-plane-boundary.md)) keeps tool results off the
wire, but some text must cross it: the user's message, replayed chat history, recalled
context, and stored text a memory job sends to its model. Session logs store answers with
their real values restored, and an answer rendered by `v4_render_answer` carries values its
model never saw, so replaying history hands those values to the next turn's model.

Which free text is masked, by what mechanism, and what happens when masking cannot be done?
This record is retroactive.

## Decision Drivers

- The model needs readable text, so interning is not an option for a prompt.
- Persisted data and the user's answer must hold real values, never placeholders.
- No pass-through-unmasked path.
- The operator decides whether their own users' typed text is masked.

## Considered Options

- **A — Realistic, type-shaped surrogates substituted on the wire, a per-turn
  surrogate↔real map held server-side, restore over the answer and everything persisted.**
- **B — Opaque token placeholders on the wire** (the removed `«TYPE_N»` scheme).
- **C — Mask nothing in free text; rely on the tool-result boundary alone.**

## Decision Outcome

Chosen option: **A**, with two tiers of what is masked.

- **Always, whatever the settings:** assistant answers a channel replays in `priorTurns`,
  recalled context (knowledge-graph recall, session tail), the memory jobs' stored text and
  the answer verifier's evidence. `maskReplayedAnswer` masks identity-shaped C0 spans
  (e-mail, IBAN, phone, address, id number), the operator deny-list and names when the C1
  detector is wired; dates and amounts stay, as in a digest. A job outside a turn opens
  `openStoredTextScope` with its own map (`storedTextScope.ts`).
- **Only with `mask_user_prompt` on (default `off`):** the user's message, inlined document
  text, replayed user messages, steering text and a verifier correction hint, in every
  model-bound copy of the turn (`maskPromptForWire`). Off is byte-identical to the
  behaviour before #361.
- **Restore.** The map is inverted over the final answer, over card content and over what
  is persisted (`promptSurrogates.ts`). Tools get real values: whole surrogates in a data
  tool's input are restored before the handler runs, and every tool result text is masked
  again with the turn's known values (#1544).
- **Fail closed.** A failing C1 detector degrades to C0 for the rest of the turn, logged as
  `promptMaskDegraded`. A C0 or deny-list failure, or a detected span that survives
  substitution, answers `blocked`: the turn ends with a privacy notice
  (`PromptMaskBlockedError`), a job skips its model call. The mask runs before the
  `onBeforeTurn` hooks (#1547).
- **Receipt.** Masked spans are booked by type and detector only: `maskedPromptSpans` for
  the user's own text, `maskedContextSpans` for earlier context (#1541).
- **Shield-minted shapes.** Reserved surrogate shapes (a pool address at `example.net`,
  `PLATZHALTER-(CUSTOM|NAME|IDNUM)-<n>`) are not masked again; surrogates are unique
  case-insensitively so a case-insensitive restore cannot swap two people (#1528, #1529).

### Consequences

- 🟢 **Good:** History and recall no longer leak values a shielded turn restored.
- 🟢 **Good:** The model reads natural text; persisted data stays real.
- 🔴 **Bad:** With the default (`off`) a user's typed text reaches the model as typed.
- 🔴 **Bad:** Names are masked only with the optional C1 detector
  ([ADR-0090](0090-c1-name-detector-sidecar-and-locale-gates.md)); a C1 outage silently narrows masking to
  C0 for the turn (audited, not blocked).
- 🔴 **Bad (accepted residuals):** restore is best-effort (a throwing restore leaves
  surrogates in place); a value a tool echoes in another form is not re-masked; a model
  rewrite restore cannot map leaves a notice (`PSEUDONYM_UNRESOLVED_NOTICE`); embeddings,
  images, plugin `ctx.llm` requests and the subscription CLI are not covered
  (`docs/security-architecture.md` §6f).
- ⚪ **Neutral:** Agent names are exempt under
  [ADR-0036](0036-agent-names-are-not-personal-data.md).

## Pros and Cons of the Options

### A — Realistic surrogates with server-side restore

- 🟢 The model keeps grammar and type information; nothing real is on the wire.
- 🔴 A model can rewrite a surrogate; restore needs case, e-mail-part and value-literal
  matching (`valueLiterals.ts`) and still has gaps.

### B — Opaque tokens

- 🟢 Unambiguous to restore.
- 🔴 The token-map failure modes recorded in `plugin-api/src/piiAnnotation.ts`; models
  treat tokens as noise.

### C — No free-text masking

- 🟢 No detector dependence, no latency.
- 🔴 Restored values re-enter the wire through history and recall on the very next turn.

## More Information

- Code: `middleware/packages/harness-plugin-privacy-guard/src/promptMask.ts`,
  `promptSurrogates.ts`, `storedTextScope.ts`, `valueLiterals.ts`;
  `middleware/packages/harness-orchestrator/src/promptSurrogateToolInput.ts`;
  `middleware/packages/harness-orchestrator-extras/src/jobPrivacy.ts`.
- Docs: `docs/security-architecture.md` §6f; `docs/trust-and-privacy.md`.
- Tests: `middleware/test/privacyPromptMask.test.ts`, `privacyStoredTextJobs.test.ts`,
  `test/orchestrator/promptMaskPipeline.test.ts`, `promptMaskBlockedBeforeHooks.test.ts`,
  `promptMaskToolInputRestore1544.test.ts`, `promptMaskRewrittenSurrogate.test.ts`.
