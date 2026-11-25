# 0096 — Receipts are hash-chained and checkpoint-signed: detection, not prevention, verifiable offline

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  issues #758 (PR #770), #761 (PR #773), #1565–#1568, #1584 (PR #1609).
- **Supersedes:** —

## Context and Problem Statement

Receipts ([ADR-0093](0093-privacy-receipt-only-when-the-shield-acted.md)) are rows in the operator's own
Postgres. The person an auditor has to worry about is the database admin, who can edit or
delete rows and drop any trigger. A claim like "cryptographically verifiable audit trail"
is only allowed if code backs it (`docs/ai-act-transparency.md`).

How can a third party tell whether the receipt record was changed, without trusting the
server that exports it? This record is retroactive.

## Decision Drivers

- The adversary owns the database; nothing stored there can be the root of trust.
- Bounded retention must stay legal (rows are deleted by age).
- An auditor must be able to read the whole verifier before running it.
- "Verified" must never be reported for something nobody vouches for.

## Considered Options

- **A — Hash chain per row, periodic Ed25519 checkpoints with a key outside the database,
  an optional external append-only anchor file, and a zero-dependency offline verifier.**
- **B — Database triggers and permissions only.**
- **C — Sign every row.**
- **D — An external transparency log or WORM service as a requirement.**

## Decision Outcome

Chosen option: **A**. Threat model: detection, not prevention.

- **Chain.** Each `turn_receipts` row stores `entry_hash` over its canonical payload
  (`canonicalJson`, the JCS subset) plus the previous row's hash; appends are serialised
  through a locked stream head; `HASH_VERSION` is stored per row (migration `0041`).
  `created_at` is outside the hash: time is anchored by checkpoint cadence.
- **Checkpoints.** A worker signs the head with `AUDIT_SIGNING_KEY` (Ed25519, env or
  secret manager, never Postgres), every `AUDIT_CHECKPOINT_INTERVAL_MINUTES` (default 60).
  It signs only a head that is a stored row and refuses while its process witness or the
  anchor disagrees with the database.
- **Anchor.** `AUDIT_ANCHOR_PATH` is an external JSONL file; every anchored checkpoint must
  still be in `audit_checkpoints` unchanged, and with signing on a missing file is a
  finding.
- **Three verdicts.** `verified` (every entry intact and at least one signature-valid
  checkpoint certifies a stored entry), `unsigned` (consistent, but nothing vouches for
  it; offline exit code 3), `broken`. Without a key the verdict is never `verified`.
  `checkpoints.verified` counts signature-checked checkpoints only.
- **Retention.** DELETE stays legal; the reaper (`RECEIPT_RETENTION_DAYS`, default 90)
  deletes chained rows only below the greatest checkpointed seq. A reaped row above a
  checkpoint younger than the retention window is a finding (`prematureDeletion` on the
  server, `premature_deletion` offline).
- **Head is consulted.** A wiped or tail-truncated table cannot report green
  (`empty_chain_with_history`, `head_beyond_rows`, `no_signed_checkpoint` after two
  checkpoint intervals).
- **Same rules offline.** `GET /api/v1/operator/provenance/verify`, a JSONL export
  (`omadia-audit-export-v1`) and `scripts/verify-audit-export.mjs`, which depends only on
  `node:crypto`. Offline, `verified` needs the key pinned with `--pubkey`. Verify and
  export read one REPEATABLE READ snapshot and walk every row.
- **Triggers are defence in depth.** UPDATE on receipts and changes to checkpoints and the
  head are trigger-forbidden (migrations `0041`, `0064`); the table owner can drop them.

### Consequences

- 🟢 **Good:** An edit, a gap or a rewritten chain is visible to someone holding only the
  public key and the anchor file.
- 🟢 **Good:** A keyless install still builds the chain and is told plainly it is `unsigned`.
- 🔴 **Bad (documented limit):** without an anchor, an admin who deletes checkpoints can
  delete or rewrite every row above the newest one left; the chain hash is unkeyed. Only
  the witness of the process that signed them notices, not another replica and not after a
  restart.
- 🔴 **Bad:** A destroyed record cannot be recovered; a turn the middleware never wrote
  cannot be shown; per-row time is only as fine as the checkpoint cadence.
- 🔴 **Bad:** The export header is unsigned, so the anchor must be fetched before the export.
- ⚪ **Neutral:** One stream today (`RECEIPT_STREAM_ID = 'receipts'`); one anchor file
  belongs to one database.

## Pros and Cons of the Options

### A — Chain, signed checkpoints, anchor, offline verifier

- 🟢 Trust root outside the database; cheap appends.
- 🔴 Operators must manage a key and, for tail-truncation evidence, external storage.

### B — Triggers and permissions

- 🟢 No key management.
- 🔴 The table owner drops the trigger; proves nothing to a third party.

### C — Sign every row

- 🟢 Per-row authenticity.
- 🔴 The signing key would sit on every write path; deletion of rows stays undetected
  without a chain.

### D — External transparency log required

- 🟢 Strongest evidence.
- 🔴 A hard external dependency for a self-hosted product; the anchor file leaves it to
  the operator's storage.

## More Information

- Code: `middleware/src/receipts/` (`chain.ts`, `store.ts`, `checkpoints.ts`, `anchor.ts`,
  `verify.ts`, `verifyRoutes.ts`), `middleware/scripts/verify-audit-export.mjs`,
  `generate-audit-signing-key.mjs`; migrations `0041_receipt_hash_chain.sql`,
  `0064_audit_chain_guards.sql`.
- Docs: `docs/provenance-verification.md`, `docs/security-architecture.md` §7b.
- Tests: `middleware/test/receiptHashChain.test.ts`, `provenanceVerify.test.ts`,
  `provenanceTamper.test.ts`, `receiptChainGuards.pg.test.ts`, `receiptChainOrder.pg.test.ts`.
