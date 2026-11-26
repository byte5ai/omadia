# 0221 — A fast-lane miss hands its executed call to the agent

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Wave 5 cluster W15-17, under the owner's autonomy grant for wave 5; tracked by
  #1930 (with #1898 and #1931, which fit ADR-0074 as it stands).
- **Supersedes:** —
- **Amends:** [ADR-0074](0074-fast-lane-one-triage-deterministic-query-any-miss-falls-back.md),
  bullet "Miss" (the inner agent no longer runs byte-for-byte after a miss whose tool call
  already ran).

## Context and Problem Statement

ADR-0074 says that on any miss "the inner agent runs byte-for-byte". Some misses happen *after*
the fast lane's one read query ran: the output did not map onto the planned columns, it had no
rows, the tool returned an error, or the summary template could not be rendered. The fast lane
threw that result away and the agent called the same tool again — the user waits for the same
query twice, the system it reads gets it twice, and
[ADR-0075](0075-one-request-runs-each-tool-once-and-records-the-delivered-answer.md) (one request
runs each tool once) is broken in spirit.

What does the agent get from a call the fast lane already made?

## Decision Drivers

- One request runs each tool once (ADR-0075).
- The Privacy Shield must not be bypassed: under a shield the agent's own tool calls see the
  shield's digest, never raw rows
  ([ADR-0094](0094-privacy-shield-data-plane-boundary.md)).
- The hand-off must go through a path the orchestrator already masks for the wire.
- Misses before any call (privacy refusal, boundary, invalid plan, tool not permitted) keep
  ADR-0074's byte-for-byte rule.

## Considered Options

- **A — Per-turn hint with the call and its output.** The miss carries the executed call
  (tool, resolved input, raw output, row count); the fast-lane wrapper adds it to the agent turn as
  a per-turn system hint (`ChatTurnInput.extraSystemHint`), which the orchestrator masks through
  the turn's privacy map. Under a Privacy Shield only the call and row count go along, not the
  output.
- **B — Pre-seed the tool replay ledger.** Record the call in the turn's `ToolReplayLedger` so the
  agent's identical call returns the recorded outcome.
- **C — Keep byte-for-byte.** Accept the duplicate call.

## Decision Outcome

Chosen option: **A**, because it works for any input the agent chooses (the agent sees what ran
and decides), uses an already masked wire path, and keeps raw rows away from a shielded model.

- **Carrier.** `ChatTriageOutcome` (`@omadia/fast-path`) of kind `agent` gets an optional
  `executed: { tool, input, output, rows? }`, set for the post-fetch misses `tool-error`,
  `truncated`, `unmappable`, `empty-result` and `summary-unresolvable`. `fetchRecipeRows` returns
  the executed call on every result after the tool returned.
- **Hand-off.** `fastLaneHandoffHint` (`harness-orchestrator/src/fastLaneHandoff.ts`) writes the
  hint: the call, the miss reason, and — without a Privacy Shield — the output (at most 12 000
  characters). With zero rows it tells the agent not to repeat the call; after a `tool-error` it
  allows a corrected retry. Under a shield, or when the guard check throws, the output stays out
  and the agent calls the tool itself if it needs the data.
- **Untrusted data, marked as such.** The output is third-party content (free-text fields, error
  strings) that would otherwise arrive as a `tool_result`. The hint wraps it in
  `<fast_lane_tool_output>` tags (tags inside the output are removed) and states that the block is
  data, not instruction (cf. [ADR-0078](0078-tool-errors-reach-the-model-by-provenance.md),
  provenance of tool content).
- **ADR-0074 otherwise unchanged:** misses before any call pass the very same input object on.
- **Fitting refinements of ADR-0074 in the same change** (no new decision, recorded for
  completeness): a planned column that no returned record fills counts as a wrong map and is
  refused like a wrong shape (#1898; the plan is booked as a failure, the answer cache is not
  written); the router may answer `agent_no_tool` ("none of the offered tools returns this") and
  needs confidence 0.8 instead of 0.6 when only one tool is offered (#1931).

### Consequences

- 🟢 **Good:** No duplicate read after a post-fetch miss on unshielded turns; an empty result is
  answered without a second query.
- 🟢 **Good:** The shield's guarantee holds: a shielded model never sees the raw output.
- 🔴 **Bad:** The hint adds up to 12 000 characters to the agent turn's uncached system text.
- 🔴 **Bad:** Under a shield the duplicate call remains (accepted: privacy wins).
- 🔴 **Bad:** The output sits in a system block, a higher standing than a `tool_result`; the data
  marking is a prompt instruction, not an enforced boundary (accepted residual prompt-injection
  risk, same class as replayed answers).
- 🔴 **Bad:** The answer verifier ([ADR-0070](0070-answer-verifier-evidence-bound-verdicts-and-enforce-delivery-gate.md))
  does not count the hint as evidence: claims drawn only from it can be judged unverified, and in
  `enforce` mode a retry may run the query again. Follow-up: feed the executed call into the
  verifier's evidence.
- ⚪ **Neutral:** Option B stays possible later for exact-input repeats.

## Pros and Cons of the Options

### A — Per-turn hint with the call and its output

- 🟢 Independent of the agent's exact input; masked wire path.
- 🔴 Costs prompt tokens; prose instruction, not enforcement.

### B — Pre-seed the tool replay ledger

- 🟢 Enforced, no prompt tokens.
- 🔴 Matches only an identical canonical input (the fast lane normalizes inputs, e.g. limits and
  `{today}`); the ledger's replay is built for re-entries, not first passes.

### C — Keep byte-for-byte

- 🟢 Simplest.
- 🔴 The reported bug: the same query twice per turn.

## More Information

- Issues #1930, #1898, #1931.
- Code: `middleware/packages/harness-plugin-fast-path/src/{fastPath,service,refreshRecipes,router}.ts`,
  `middleware/packages/harness-orchestrator/src/{fastPathAgent,fastLaneHandoff}.ts`.
