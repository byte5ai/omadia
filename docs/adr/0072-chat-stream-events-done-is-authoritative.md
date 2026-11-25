# 0072 — Chat stream events: `text_delta` is a preview, `done` is authoritative, new fields are additive

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); the single
  rules trace to #506/#1094 (degraded terminal), #1105/#1097 (`answerSource`, `answerIsError`),
  #1500 (`text_retract`), #641 (correlation id), #643/#644 (disclosure on `done`)
- **Supersedes:** —

## Context and Problem Statement

`ChatAgent.chatStream` emits `ChatStreamEvent`s (`@omadia/channel-sdk`, `chatAgent.ts`). The
web UI, the public NDJSON API, the channel plugins and several kernel wrappers (verifier,
identity guard, fast lane, answer-details recall) all consume or re-emit them. Several things
can make the final answer differ from the streamed text: a server-side privacy render, the
verifier withholding the answer, the identity guard stopping mid-answer, a folded AI disclosure.
This record is retroactive; the contract grew issue by issue and is written down here once.

What may a consumer rely on?

## Decision Drivers

- One event shape for every channel; production callers need only the terminal event.
- Old clients and connectors must keep working when the kernel adds information.
- A wrapper that holds events must not leak content through an event it does not understand.
- A committed side effect must never be reported as a failed turn.

## Considered Options

- **A — Preview deltas plus one authoritative terminal `done`; additive optional fields; a
  degraded `done` instead of `error` after committed tool calls.**
- **B — Deltas are the answer;** corrections arrive as further events.
- **C — A new event type per concern** (disclosure, verdict, receipt, provenance).

## Decision Outcome

Chosen option: **A**.

- **`done.answer` is authoritative.** `text_delta` is a preview. Consumers render `done.answer`
  when it differs. `answerSource` says why it can differ: `'privacy-render'` (materialized
  server-side) or `'verifier-blocked'` (the notice; the stream then carried exactly one
  `text_delta`). `answerIsError` marks an answer that is not a result.
- **`text_retract { chars }`** takes preview characters back (a preamble before a data-gathering
  tool call). It carries no text on purpose, so a hold that re-emits non-delta events leaks
  nothing; `done.answer` restores the text if no answer follows.
- **Terminals.** A turn ends in `done` or `error`. A turn that throws after at least one tool
  call committed ends in `done` with `degraded: true`, `committedTools` (distinct names in
  first-commit order) and the `correlationId` an `error` would carry. It stays `done` because
  reporting a committed call as failed makes the next turn re-invoke it (#506).
- **Additive and optional.** Every later field on `done` (`verifier`, `privacyReceipt`,
  `receiptId`, `aiDisclosure`, `provenance`, `data` / `textWithoutData`, `fastPathDecision`,
  `model`, `turnId`, pending cards) is optional, and a client that ignores it behaves as before.
  New information rides `done` rather than a new event type where the terminal is the natural
  carrier (the AI disclosure does).
- **Interactive cards are fields of `done`,** not events: `pendingUserChoice`, `pendingMcpInput`,
  `pendingSlotCard`, `pendingOAuthConsent`, `followUpOptions`.
- **Liveness is separate from content:** `heartbeat`, `tool_progress`, `stream_token_chunk`,
  `iteration_usage`, `iteration_start` carry no model or tool output. A wrapper that holds
  content uses a closed allowlist of these, so an event type added later is held by default
  ([ADR-0070](0070-answer-verifier-evidence-bound-verdicts-and-enforce-delivery-gate.md)).
- **Sub-agent traffic** is surfaced as `sub_iteration`, `sub_tool_use`, `sub_tool_result` keyed
  by `parentId`, so a long helper call is not a black box.

### Consequences

- 🟢 **Good:** Wrappers can replace, hold or withhold an answer without a protocol change.
- 🟢 **Good:** A partially executed turn tells the client what did happen.
- 🔴 **Bad:** A client that only concatenates `text_delta` shows wrong text on a render, a
  withhold or a retract. Every consumer must handle `done.answer`.
- 🔴 **Bad:** `done` has become a wide object; its fields are documented only in the type.
- 🔴 **Bad:** A client that ignores `degraded` renders an unanswered question as a success.
- ⚪ **Neutral:** `tool_use` / `tool_result` carry a `foreign` flag for a subscription-CLI
  built-in tool that slipped through, so it never looks like an omadia tool.

## Pros and Cons of the Options

### A — Preview plus authoritative terminal

- 🟢 Backward compatible; one place to read the truth.
- 🔴 Two sources of text a client must reconcile.

### B — Deltas are the answer

- 🟢 Simplest client.
- 🔴 A withheld or rendered answer cannot be expressed without un-sending text.

### C — One event type per concern

- 🟢 Narrow events.
- 🔴 Every new type is content a holding wrapper must classify; old NDJSON clients see unknown
  lines.

## More Information

- Code: `middleware/packages/harness-channel-sdk/src/chatAgent.ts` (`ChatStreamEvent`),
  `middleware/packages/harness-orchestrator/src/verifierDelivery.ts` (`passesBeforeVerdict`),
  `identityGuard/guardedChatAgent.ts` (`text_retract` through the sentence gate).
- Tests: `middleware/test/orchestrator/committedToolReporting.test.ts`,
  `turnOutputPreambleAndHookOutcome.test.ts`, `turnErrorCorrelation.test.ts`,
  `v4RenderSideChannel.test.ts`, `middleware/test/identityGuardRetract.test.ts`.
- Related: ADR-0006, ADR-0013, ADR-0021 (side-channel `data`).
- Border: channels (the type lives in channel-sdk).
