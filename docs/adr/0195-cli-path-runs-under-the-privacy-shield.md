# 0195 — The subscription-CLI path runs under the Privacy Shield instead of being refused

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Owner (byte5), decided after the recommendation of the wave-5 recheck (#2239)
- **Supersedes:** [ADR-0165](0165-model-gateway-is-an-admission-check-per-adapter.md) in part:
  "a subscription-CLI turn is refused before the spawn whenever a privacy guard is installed"

## Context and Problem Statement

ADR-0165 refused every subscription-CLI (`claude-cli`) turn while a privacy guard was
installed, because the CLI path had no Privacy Shield: the prompt, the replayed history and
every tool result reached the CLI child unmasked (#1087). The consequence was that agents on
the subscription could not answer at all on a guarded instance. The pieces an in-process turn
uses exist and are provider-neutral: the per-turn privacy handle, prompt masking and restore
(ADR-0095), tool-result interning and the v4 verb/render tools (ADR-0094), and the receipt.
The CLI reaches omadia's tools only through the loopback MCP server, which dispatches through
`ToolDispatchService`, and that service already interns results through the ambient handle.

Can the CLI path carry the shield, so that a guarded instance can run CLI agents?

## Decision Drivers

- Nothing personal may reach a model on an instance whose operator installed the shield.
- The same guarantees as an in-process turn, from the same code, not a second implementation.
- The stream must not show a surrogate the user cannot read, nor leak one half restored.
- A turn that cannot be guarded must fail closed, as before.

## Considered Options

- **A — Mask the CLI path through the turn's privacy handle**, lift the refusal
- **B — Keep refusing CLI turns under a guard** (ADR-0165 as written)
- **C — Run CLI turns unmasked and mark them `unprotected`**

## Decision Outcome

Chosen option: **A**.

- **One handle per CLI turn.** `CliChatAgent` gets it at the public entry
  (`captureTurnContext`) from `Orchestrator.cliTurnPrivacy` (`CliChatAgentDeps.turnPrivacy`),
  keyed by the CLI turn id, and puts it on the turn context (`privacyHandle`) after the
  discretion state. From there the loopback tool dispatch interns every result and the history
  replay masks through it (`maskHistory`).
- **Masked before the spawn.** The user message and the steering hint
  (`maskPromptForWire`, under `mask_user_prompt`), the recalled context (always, like a
  replayed answer) and the replayed history (`origin: 'context'`). A blocked mask ends the
  turn with the privacy notice before anything is spawned (ADR-0095).
- **Tools.** The v4 verb and render tools are advertised over the same loopback server and
  served by the handle; the system prompt carries the same data-plane directive as the
  in-process prompt (`privacyV4Directive`). A data tool's input gets its prompt surrogates
  restored before the handler runs, and every result is masked again with the turn's known
  values (#1544); intern-exempt self tools and sub-agent tools keep the placeholders.
- **Stream restore.** Text deltas pass `StreamSurrogateRestorer`: text is released only up
  to a cut after which no surrogate can be open (the last line break, or a whitespace at
  least 96 characters back whose restored prefix agrees with the restore of the whole
  buffer), so a surrogate split across chunks restores whole. A room that may not see
  personal fields gets the surrogates. The `done` answer stays authoritative.
- **Answer and receipt.** The final answer takes the server render when `v4_render_answer`
  ran (`answerSource: 'privacy-render'`), is restored (`restoreAnswerForUser`, with the
  unresolved-surrogate notice), persisted in its restored form and checked for people egress.
  The receipt is drained once and rides the `done` (`receiptId` = the CLI turn id); a failed
  or refused turn still finalizes.
- **A CLI sub-agent asked inside a guarded turn** has no shield of its own. It masks its
  prompt through the calling turn's handle and returns its answer unrestored, because that
  answer goes back to the calling model. A blocked mask is not spawned.
- **Fail closed.** A turn that must be guarded (an installed guard, or
  `OMADIA_PRIVACY_FORCE_GUARDED`) and has neither its own handle nor a caller's is refused
  before the spawn, as ADR-0165 required for every CLI turn (`CLI_PRIVACY_GUARD_ACTIVE_LOG`,
  `CLI_PRIVACY_SHIELD_REQUIRED_LOG`).

### Consequences

- 🟢 **Good:** CLI agents answer on guarded instances with the same masking, interning,
  restore and receipt as an API-key turn.
- 🟢 **Good:** The streamed preview shows real values, not surrogates, with no partial leaks.
- 🔴 **Bad:** The stream holds back up to a line (or 96 characters) of text under the shield.
- 🔴 **Bad (accepted residuals):** a CLI sub-agent inside a guarded turn sees interned digests
  of its own tools' results and gets no v4 tools, so it cannot render rows; the CLI's own tool
  trace events (`tool_use` inputs) still show the model's placeholders to the client.
- ⚪ **Neutral:** Operator tools outside any turn (Builder, preview chat) are decided in
  [ADR-0196](0196-operator-tool-cli-sub-agents-run-outside-the-shield.md).

## Pros and Cons of the Options

### A — Mask the CLI path

- 🟢 Parity with the in-process path from the same functions.
- 🔴 More moving parts in `CliChatAgent`; the stream restore is a heuristic over a sync map.

### B — Keep refusing

- 🟢 Nothing new to get wrong.
- 🔴 Agents on the subscription are unusable on every guarded instance.

### C — Run unmasked, marked `unprotected`

- 🔴 Breaks the shield's promise on the instances that installed it.

## More Information

- Related: [ADR-0165](0165-model-gateway-is-an-admission-check-per-adapter.md),
  [ADR-0094](0094-privacy-shield-data-plane-boundary.md),
  [ADR-0095](0095-prompt-masking-wire-substitution-fail-closed.md),
  [ADR-0086](0086-subscription-logins-as-providers.md).
- Code: `harness-orchestrator/src/cliTurnPrivacy.ts`, `cliChatAgent.ts`
  (`captureTurnContext`, `installPrivacy`, `maskTurnInput`), `Orchestrator.cliTurnPrivacy`.
- Tests: `test/cliBridge/cliPrivacyMasking.test.ts`,
  `test/orchestrator/cliTurnPrivacy2239.test.ts`, `test/cliPrivacyGuardRefusal.test.ts`.
- Implemented in #2239.
