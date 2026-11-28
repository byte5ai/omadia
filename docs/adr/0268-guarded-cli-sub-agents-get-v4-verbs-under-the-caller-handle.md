# 0268 — A CLI sub-agent in a guarded turn gets the v4 verb tools under the caller's handle

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** Wave 6 cluster W32, under the owner's autonomy grant; tracked by #2301.
- **Supersedes:** —
- **Refines:** [ADR-0195](0195-cli-path-runs-under-the-privacy-shield.md) (bullet on a CLI
  sub-agent masking through the calling turn's handle); conforms to
  [ADR-0196](0196-operator-tool-cli-sub-agents-run-outside-the-shield.md) (operator jobs stay
  outside the shield).

## Context and Problem Statement

A CLI sub-agent asked inside a guarded turn (`ask_<slug>` on a subscription-CLI host) masks its
prompt through the calling turn's handle, and `ToolDispatchService` interns its own tool results
through that ambient handle (ADR-0195). Its model therefore sees only dataset digests, but it was
offered no v4 tools to filter, group or count them, and its tool inputs kept the prompt
surrogates, so a lookup by a masked name searched for the placeholder. The main CLI turn has all
of this through `Orchestrator.cliTurnPrivacy`. What does a guarded CLI sub-agent get?

## Decision Drivers

- The same guard as the main turn: no raw value reaches the sub-agent model.
- A render is the turn's answer; a sub-agent's answer is an input to the calling agent.
- The in-process `LocalSubAgent` restores surrogates in tool inputs and re-masks results.

## Considered Options

- **A — Verb tools and the dispatch wrapper under the caller's handle, no render tool.**
- **B — All v4 tools including `v4_render_answer`.** A sub-agent's render would be taken as the
  whole turn's answer when the calling turn releases.
- **C — Keep the sub-agent on digests only.** The reported gap.

## Decision Outcome

Chosen option: **A**.

- When a CLI turn has no handle of its own but a caller handle (`callerPrivacy`), the loopback
  server advertises the caller handle's v4 verb tools (`callerPrivacyTools`: every
  `v4ToolSpecs()` entry except `v4_render_answer`) and the system prompt gets a short data-plane
  directive (`CALLER_PRIVACY_SUB_AGENT_DIRECTIVE`).
- The dispatch (`withCallerPrivacyDispatch`) serves `v4_*` verbs through the caller handle's
  `runV4Tool` (the datasets are the turn's), refuses `v4_render_answer` as a tool error, and runs
  every other call with the turn's prompt surrogates restored in its input and its result
  re-masked, as `cliTurnPrivacy.wrapDispatch` does for the main turn.
- A provider without the v4 data plane (`v4ToolSpecs` missing) adds nothing.
- Operator jobs (Builder, preview chat) run outside any turn and are unchanged (ADR-0196).

### Consequences

- 🟢 **Good:** A guarded CLI sub-agent can answer counting and filtering questions over its own
  results without ever seeing raw values.
- 🟢 **Good:** Lookups by a masked name reach the tool with the real value.
- 🔴 **Bad:** The sub-agent cannot render a table itself; the calling agent renders from the
  turn's datasets.
- ⚪ **Neutral:** Datasets the sub-agent interned are not bridged to the parent's
  `subAgentDatasetSink` on the CLI path (orchestrator-only seam in `toolDispatchService.ts`).

## More Information

- Issue #2301; code `middleware/packages/harness-orchestrator/src/{cliCallerPrivacy,cliChatAgent}.ts`;
  tests `middleware/test/cliBridge/cliSubAgentCallerV4Tools2301.test.ts`,
  `middleware/test/cliBridge/cliPrivacyMasking.test.ts`.
