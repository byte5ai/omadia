# 0089 — AI disclosure is computed behind the model, in the outgoing contract, and only an operator can switch it off

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); epic
  #642 with #643 (carrier, PR #661), #644, #645, #646, #647, #648; frequency setting #2087.
- **Supersedes:** —

## Context and Problem Statement

EU AI Act Art. 50 requires that people can tell they are talking to an AI and that
generated artefacts are marked. omadia answers through channel plugins, and operators give
agents human-sounding names and personas (ADR-0012). An instruction in the system prompt
can be ignored by the model and is overridden by the persona configuration: an operator
who names the assistant would have switched disclosure off without ever deciding to.

Where is the disclosure produced so that it holds on every channel, including ones that do
not exist yet? This record is retroactive; ADR-0021 fixes only that the disclosure stays
and how discreetly it is shown.

## Decision Drivers

- Must not depend on model compliance or persona settings.
- Must reach channels with no provenance slot of their own.
- A missing disclosure is a compliance gap; a repeated one is only noise.
- Public claims must be covered by code (`docs/ai-act-transparency.md`).

## Considered Options

- **A — Compute the disclosure after the model, in the outgoing contract every channel
  shares; two carriers; static machine-readable marks where a format has a slot.**
- **B — A system-prompt instruction.**
- **C — Leave it to each channel plugin.**

## Decision Outcome

Chosen option: **A**.

- **Behind the model.** `Orchestrator.resolveTurnDisclosure` reads nothing from the
  assistant identity, the persona override or the system prompt.
- **Two carriers, deliberately redundant** (`harness-channel-sdk/src/aiDisclosure.ts`):
  the structured field `SemanticAnswer.aiDisclosure` on every answer, and a line folded
  into `SemanticAnswer.text`, the one field every connector must render.
- **Asymmetric fail-safe.** The text line is folded on the first turn of a scope
  (`shouldFold`, `DisclosureSeenStore`); with no scope, no store or a throwing store it is
  folded.
- **Default on, off only by the operator.** `DEFAULT_AI_DISCLOSURE_POLICY` is `standard`.
  `applyAiDisclosure` discards an `off` whose `source` is not `operator`. The operator
  note is appended after the disclosure line and cannot replace it.
- **Posture is visible.** Since #648 `/health` reports the resolved level per channel, the
  dashboard flags a deviation from the default and boot warns only when there is one.
- **Machine-readable marks are static.** `.docx` custom properties, `.xlsx` core
  properties, a PNG `iTXt` chunk, `X-AI-Generated: true` plus `provenance` on the chat
  API's `done` event, and `_meta` on public MCP results. No timestamp, turn id or model id
  in a file: stores are content-addressed and a per-render value would break
  deduplication. The API header is set at `flushHeaders()`, before the turn runs, so it
  survives every error path.

### Consequences

- 🟢 **Good:** A persona or a non-compliant model cannot remove the disclosure.
- 🟢 **Good:** A new channel inherits it without code of its own.
- 🔴 **Bad:** The core cannot force a third-party connector to render `text` unchanged.
- 🔴 **Bad:** Plain text in Teams, Slack, Telegram and WhatsApp carries no
  machine-readable mark; `.xlsx` is marked more coarsely than `.docx`; two provenance
  vocabularies exist (`AIGenerated` in files, `aiGenerated` in envelopes).
- 🔴 **Bad:** Per-channel overrides take effect only where a turn carries a `channelKind`;
  an override for `email` or `web` is accepted and shown but does not apply
  (`docs/ai-act-transparency.md` §6).
- ⚪ **Neutral:** C2PA is not implemented. How often visible markers appear is the operator
  setting of #2087 under ADR-0021.

## Pros and Cons of the Options

### A — Outgoing contract

- 🟢 Deterministic (ADR-0021), channel-agnostic, operator-visible.
- 🔴 A line inside `text` is cruder than a native label.

### B — System prompt

- 🟢 Natural wording.
- 🔴 The model may ignore it; the persona overrides it.

### C — Per channel

- 🟢 Best native rendering.
- 🔴 Every new or third-party channel is a new chance to forget it.

## More Information

- Related: [ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md),
  [ADR-0013](0013-speaker-stamping-and-identity-guard.md),
  [ADR-0012](0012-agents-are-virtual-employees.md).
- Code: `middleware/packages/harness-channel-sdk/src/aiDisclosure.ts`, `provenance.ts`;
  `middleware/packages/harness-orchestrator/src/aiDisclosurePosture.ts`, `plugin.ts`
  (`resolveAiDisclosureSetup`); `middleware/packages/harness-plugin-office/src/provenance.ts`;
  `middleware/packages/harness-diagrams/src/pngTextChunk.ts`.
- Docs: `docs/ai-act-transparency.md`.
- Tests: `middleware/test/aiDisclosure.test.ts`, `aiDisclosure644.test.ts`,
  `aiDisclosurePosture.test.ts`, `aiDisclosureFrequencySetup.test.ts`,
  `pngTextChunk.test.ts`.
