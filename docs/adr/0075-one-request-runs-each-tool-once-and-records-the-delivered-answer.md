# 0075 — One user request runs each tool call once and records the answer the user got

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; implemented in #1267 (replay ledger, commit-on-delivery),
  hardened in #1613 and #1650; record gate for withheld answers in #2189
- **Supersedes:** —

## Context and Problem Statement

In `enforce` mode the answer verifier re-enters a turn: a borderline verdict draws a second
sample, a contradiction a correction retry. Each re-entry used to be a complete fresh turn, so a
write the first run had made ran two or three times for one user request, and the first run
wrote its session-log row before the verdict, so a delivered correction left the contradicted
first answer in the session log, the knowledge graph and recall. Separately, a tool call that
ended in an exception could be repeated identically by the model, although an exception says
nothing about whether a write took effect. This record is retroactive.

How often may a tool run per user request, and which pass of the request is its record?

## Decision Drivers

- At most once beats at least once for writes.
- The plugin contract has no read-only declaration; a missing `writeCapabilities` is not one.
- The record of a request must be the answer the user received, written once.
- The ledger holds raw tool results from before the Privacy Shield.

## Considered Options

- **A — A per-request in-memory tool replay ledger; re-entries replay recorded outcomes; the
  request's record is committed on delivery.**
- **B — Caller-supplied idempotency keys** (as on the public MCP endpoint, `toolIdempotency.ts`).
- **C — Re-run tools on re-entry and deduplicate "similar" writes.**
- **D — No re-entry at all:** withhold on the first contradiction.

## Decision Outcome

Chosen option: **A**.

- **Ledger** (`toolReplayLedger.ts`). Created per request, carried on
  `turnContext.toolReplayLedger` to every seam that runs a handler
  (`Orchestrator.dispatchToolDeadlined`, `LocalSubAgent.dispatch`, `ToolDispatchService.invoke`).
  The first run records each outcome under (seam, tool name, canonical input). After
  `beginReentry` a recorded call returns its recorded outcome, including a recorded exception,
  without running the handler.
- **A miss on re-entry** runs only when the seam positively knows the tool is read-only (the
  orchestrator's own kernel reads). Any other miss is refused, the re-entry is abandoned
  (`ToolReplayAbortError`) and the first answer stands. Matching is exact on the stable-JSON
  fingerprint; there is no fuzzy matching.
- **Unknown outcome is not repeated.** Independently of re-entries, a call whose handler threw,
  or whose wrapper returned the withheld-exception notice, is not run again with identical input
  in the same request unless it is read-only (`refuse-repeat`). Every turn carries a turn-local
  ledger for this, also without a verifier. Below the seams the transport does not re-send either
  (`runHandlerAtMostOnce`).
- **Uploads are ingested once** per request (`ingestAttachmentsOnce`).
- **Commit-on-delivery** (`requestTurnRecord.ts`). Every pass of a re-enterable request offers
  its session-log row and its `onAfterTurn` answer to the ledger instead of writing them. The
  verifier commits the row of the pass it delivers (for a withheld answer: the pass its final
  verdict was about), once, with the entities of every pass and one merged privacy receipt row.
- **A withheld answer does not enter memory** (`identityGuard/answerRecordGate.ts`). The identity
  guard decides last, outside the turn. Rows written inside the turn are reported to the gate; a
  withheld answer's row loses its text (the user's message stays) and fact extraction runs only
  for a kept answer.
- **The session log stores the raw model answer;** the AI disclosure is folded in at the delivery
  boundary (#644, persist-raw, disclose-at-boundary).

### Consequences

- 🟢 **Good:** A correction retry or resample cannot repeat a write of the first run.
- 🟢 **Good:** Session log, graph turn, extracted facts and `onAfterTurn` describe the delivered
  answer; a blocked draft is not recalled by later turns.
- 🔴 **Bad:** One process, one request. The ledger is never persisted or logged; a new message, a
  retried HTTP call or another instance runs tools again.
- 🔴 **Bad:** Every plugin, MCP, domain and sub-agent tool counts as a write on a miss, so a
  re-entry that wants one new plugin read is abandoned.
- 🔴 **Bad:** No undo; the first run's effects stand.
- ⚪ **Neutral:** A long-running task's detached runner uses a turn-local ledger of its own
  (`runDetachedFromRequestLedger`). A read-only declaration in plugin-api would relax the miss rule.

## Pros and Cons of the Options

### A — Replay ledger, commit-on-delivery

- 🟢 Needs nothing from tool authors; covers all three dispatch seams.
- 🔴 In-memory, exact-match, conservative on misses.

### B — Idempotency keys

- 🟢 Survives process boundaries while the record is cached.
- 🔴 The chat path has no caller key, and a re-sampled model rarely repeats a payload byte for byte.

### C — Re-run and deduplicate loosely

- 🟢 Re-entries could use fresh data.
- 🔴 Fuzzy matching would run a different write.

### D — No re-entry

- 🟢 Simplest.
- 🔴 Gives up the correction retry that turns many contradictions into a deliverable answer.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/{toolReplayLedger,verifierReentry,requestTurnRecord,turnRecordWriter,subAgentUnknownOutcome,sessionLogger}.ts`,
  `identityGuard/answerRecordGate.ts`.
- Tests: `middleware/test/toolReplayLedger.test.ts`, `toolReplaySeams.test.ts`,
  `verifierServiceWriteSafety.test.ts`, `verifierReentryRecords.test.ts`,
  `verifierDeliveredTurnRecord.test.ts`, `verifierReentryAttachments.test.ts`,
  `middleware/test/orchestrator/parentLoopThrownCallRepeat.test.ts`, `subAgentThrownCallRepeat.test.ts`.
- Related: ADR-0005 (write contract, MCP idempotency note), ADR-0013,
  [ADR-0070](0070-answer-verifier-evidence-bound-verdicts-and-enforce-delivery-gate.md).
