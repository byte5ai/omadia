# Provenance verification (#758 / #761)

How omadia's receipt record is made tamper-evident, how to verify it —
including **without trusting the omadia server** — and exactly what a green
verdict does and does not prove.

> Plain-language mechanism, one paragraph: every persisted per-turn receipt
> carries the cryptographic fingerprint (`entry_hash`) of its own content
> **plus** the fingerprint of the previous entry. Editing entry *n* changes
> its fingerprint, which no longer matches the copy stored in entry *n+1* —
> the chain visibly breaks for every later entry. Periodically the head of
> the chain is signed (Ed25519) with a key the database never holds and
> optionally appended to an external anchor file, so the whole chain cannot
> be silently rewritten either.

## The three verification layers

| Layer | Trust required | Command / surface |
|---|---|---|
| UI | the running server | `/operator/receipts` → "Verify now" (chain-status card) |
| API | the running server | `GET /api/v1/operator/provenance/verify` |
| **Offline** | **none** — only the public key you received out-of-band | `node middleware/scripts/verify-audit-export.mjs export.jsonl --pubkey omadia-audit.pub.pem` |

The offline layer is the answer to "how do we prove the provability": a
verification that only works while trusting the exporting server proves
nothing. The offline verifier is a single ~180-line Node script with zero
dependencies beyond `node:crypto` — an external auditor can read all of it
before running it.

## Setup (operator)

```bash
node middleware/scripts/generate-audit-signing-key.mjs
# → AUDIT_SIGNING_KEY (private, env/secret manager — NEVER the database)
# → public key PEM + fingerprint (hand to auditors out-of-band, pin the fingerprint)
```

Env: `AUDIT_SIGNING_KEY`, `AUDIT_CHECKPOINT_INTERVAL_MINUTES` (default 60),
`AUDIT_ANCHOR_PATH` (optional external JSONL anchor — point it at storage
the DB admin cannot rewrite). Without a key the chain still builds; only
checkpoint signing is off, loudly logged at boot.

## The five-minute tamper demo

The demo that answers "prove the proof works" for a prospect or DPO:

```bash
# 1. Produce a few turns (any chat), then export + verify — green:
curl -s -o export.jsonl --cookie "$SESSION" \
  "$BASE/api/v1/operator/provenance/export"
node middleware/scripts/verify-audit-export.mjs export.jsonl --pubkey omadia-audit.pub.pem
# ✓ chain verified …

# 2. Play the malicious admin — edit one receipt directly in the database:
psql "$DATABASE_URL" -c \
  "UPDATE turn_receipts SET receipt = jsonb_set(receipt,'{fieldsMasked}','999') WHERE seq = 2"
# (the UPDATE trigger blocks this; the demo admin drops it first —
#  which is exactly why the trigger is defence in depth, not the proof:)
psql "$DATABASE_URL" -c "DROP TRIGGER turn_receipts_no_update ON turn_receipts" \
  && psql "$DATABASE_URL" -c \
  "UPDATE turn_receipts SET receipt = jsonb_set(receipt,'{fieldsMasked}','999') WHERE seq = 2"

# 3. Export + verify again:
curl -s -o export2.jsonl --cookie "$SESSION" \
  "$BASE/api/v1/operator/provenance/export"
node middleware/scripts/verify-audit-export.mjs export2.jsonl --pubkey omadia-audit.pub.pem
# ✗ VERIFICATION FAILED:
#   - hash_mismatch at seq 2 — the payload does not match its recorded hash
```

The same offline run also catches: a deleted row (`seq_gap`), a rewritten
chain re-signed with the wrong key (`bad_signature`), a checkpoint whose
certified row vanished (`orphaned_checkpoint`), and a reaped prefix no
checkpoint vouches for (`unanchored_prefix`).

## What a green verdict proves — and what it does not

**Proves:** every surviving chained row is byte-identical to what was
recorded, in order, with no removals inside the verified range; the signed
checkpoints match the stored chain; a retention-removed prefix is anchored
(a signature-valid checkpoint in the surviving range transitively covers
the first survivor's back-link); the recorded stream head agrees with the
stored rows (a wiped or tail-truncated table is never green); and — the
laundering rule, **server verify only** (the offline tool has no retention
input) — no reaped row sits above a checkpoint younger than the retention
window, which would prove it was created inside the window and deleted
early (`premature_deletion`).

**Does not prove:** turns the middleware never wrote (a compromised
middleware can lie at write time — the anchoring cadence bounds that
window), anything about pre-chain rows (NULL chain columns, reported
separately), or per-row wall-clock time beyond checkpoint granularity.
Detection, not prevention: a root admin can destroy data — destruction is
*visible* (gaps + orphaned checkpoints), not preventable.

## Claim policy

With this surface shipped, "cryptographically verifiable audit trail" is
backed by code — the public wording change (marketing site, sales material)
is a deliberate, separate step: see `docs/ai-act-transparency.md`, which
governs every public claim.
