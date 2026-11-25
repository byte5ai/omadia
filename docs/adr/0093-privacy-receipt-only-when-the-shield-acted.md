# 0093 — The privacy receipt: PII-free, one per request, written only when the shield acted, best-effort

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  issues #757 (persistence, PR #763), #1081, #1541, #1549, #1562; PRs #1612, #1619.
- **Supersedes:** —

## Context and Problem Statement

The Privacy Shield changes what a model sees. A user and an auditor need to know what it
did in a turn: what was masked, what passed in clear and why. The run trace cannot answer
that; it is telemetry, depends on an optional graph sink and was silently incomplete
(#684). The record of a privacy control must also not become a store of personal data.

What is recorded per turn, when, where, and how reliable is it? This record is
retroactive.

## Decision Drivers

- The record must be safe to show, store and export: no values.
- An honest record: it states degradations and exceptions, not only successes.
- The user's answer must not depend on an audit insert.
- One record per request, also when the answer verifier re-enters the turn.

## Considered Options

- **A — A typed, PII-free `PrivacyReceipt` emitted by the provider, shown in the channel,
  persisted by a kernel store of its own; only for turns in which the shield acted;
  persistence best-effort and counted.**
- **B — Put privacy facts into the run trace.**
- **C — A receipt for every turn.**
- **D — Fail the turn when the receipt cannot be written.**

## Decision Outcome

Chosen option: **A**.

- **Content.** Types and counts only: tools interned and bypassed, tool errors (tool,
  carrier, outcome, byte count, masked span types), `maskedPromptSpans` for the user's own
  text and `maskedContextSpans` for earlier context (type and detector, one per distinct
  value), `verifierEgress` (request count and span types), `operatorClearedFields` with
  scope, `nameDetector: 'failed' | 'unconfigured'`, and `identityValuesOnWire` ("you named
  a person"), which is a notice and never drives masking. Agent names exempt under
  ADR-0036 are not booked.
- **When.** Only a turn in which the shield acted emits a receipt (#1081). A missing
  receipt therefore never means "this turn did not happen".
- **One row per request.** Receipts of all passes of a request (first run, verifier
  re-entries, a pass that threw or was cut off) are merged into one `turn_receipts` row
  (`requestReceipts.ts`, `mergePrivacyReceipts`); the earliest pass owns it. On streams it
  goes out with `done`, after the verifier.
- **Where.** `PgTurnReceiptStore` behind the late-bound service `turnReceiptStore`
  (migration `0039`), without graph sink or user-cluster precondition. Postgres only: on
  the in-memory backend nothing is persisted. Read through `/api/v1/operator/receipts`
  (authenticated) and the operator UI; the channel card links by `done.receiptId`.
- **Best-effort.** `record()` throws to its caller; the orchestrator logs and counts
  (`persistFailures`, `turnReceiptCounters()`) and never fails the turn. Nothing is
  retried.
- **Not booked.** Stored-text masking of jobs outside a turn has no receipt; each call
  logs `storedTextMask job=… spans=…`.

### Consequences

- 🟢 **Good:** A receipt can be shown to the user and exported to an auditor as it is.
- 🟢 **Good:** Bypasses, degraded detectors and operator-cleared fields are visible per turn.
- 🔴 **Bad (accepted):** a receipt that was never written leaves no trace in the chain:
  `seq` is assigned inside the insert transaction, so the verifier reports green without
  it, and no endpoint reports `persistFailures` yet (`docs/security-architecture.md` §7b).
- 🔴 **Bad:** Subscription-CLI turns and installs on the in-memory backend have no
  persisted receipts.
- ⚪ **Neutral:** Tamper evidence for the stored rows is
  [ADR-0096](0096-tamper-evident-receipt-chain.md).

## Pros and Cons of the Options

### A — Typed receipt, own store, only when acted, best-effort

- 🟢 Independent of trace telemetry; counted failures instead of silent ones.
- 🔴 Completeness is not provable.

### B — Run trace

- 🟢 No new store.
- 🔴 Optional sink, refused without a user-cluster node; a missing trace is normal (#684).

### C — A receipt for every turn

- 🟢 A gap would mean a lost receipt.
- 🔴 Rows without content for most turns; #1081 settled on the opposite.

### D — Fail the turn on a failed write

- 🟢 Complete record.
- 🔴 A database hiccup would take chat down; the answer outranks the audit row
  (`src/receipts/store.ts`).

## More Information

- Related: [ADR-0094](0094-privacy-shield-data-plane-boundary.md), [ADR-0078](0078-tool-errors-reach-the-model-by-provenance.md),
  [ADR-0099](0099-verifier-requests-run-under-the-turn-privacy-view.md),
  [ADR-0036](0036-agent-names-are-not-personal-data.md).
- Code: `middleware/src/receipts/store.ts`, `routes.ts`,
  `middleware/packages/plugin-api/src/turnReceiptStore.ts`,
  `middleware/packages/harness-orchestrator/src/requestReceipts.ts`,
  `middleware/packages/harness-plugin-privacy-guard/src/identityOnWire.ts`.
- Docs: `docs/ai-act-transparency.md` §6, `docs/trust-and-privacy.md`.
- Tests: `middleware/test/turnReceipts.test.ts`, `privacyReceiptTruthfulness.test.ts`,
  `verifierRequestReceiptRow.test.ts`, `test/orchestrator/turnReceiptPersistence.test.ts`.
