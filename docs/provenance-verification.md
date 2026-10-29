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
| **Offline** | **none** — only the public key you received out-of-band, plus the anchor file from storage the DB admin cannot rewrite | `node middleware/scripts/verify-audit-export.mjs export.jsonl --pubkey omadia-audit.pub.pem --anchor audit-anchors.jsonl` |

Server and offline verification apply the same rules (#1565–#1568) and
report one of three verdicts:

| Verdict | Server (`verdict` / `ok`) | Offline exit code | Meaning |
|---|---|---|---|
| **verified** | `verified` / `true` | `0` | Every entry intact, and at least one signature-valid checkpoint certifies a stored entry. |
| **unsigned** | `unsigned` / `true` | `3` | Entries are internally consistent, but nothing vouches for them: no signing key, or (key on) no checkpoint yet while every row is younger than two checkpoint intervals (`checkpoints.awaitingFirstCheckpoint`). Never reported as "verified". |
| **broken** | `broken` / `false` | `1` | A break or finding (list below). |

`checkpoints.verified` counts only checkpoints whose signature was checked
and found valid; without a key it is `0` and `checkpoints.unchecked` holds
the count (#1584). Offline, exit `0` additionally needs the key you pinned
with `--pubkey`: against only the key embedded in the export, a consistent
chain exits `3` ("not proven") — whoever handed you the export could have
re-signed it with a key of their own.

The server walks every row (no row cap) and reads head, rows and
checkpoints in one database snapshot; the export does the same and carries
the recorded head, `RECEIPT_RETENTION_DAYS` and the checkpoint interval in
its header, so the offline tool applies the same head, grace and
premature-deletion rules. The one server-only signal is the process
witness: the highest head the running process has read and the newest
checkpoint it signed must still hold (`head_rollback`, `witness_mismatch`).

The offline layer is the answer to "how do we prove the provability": a
verification that only works while trusting the exporting server proves
nothing. The offline verifier is a single ~400-line Node script with zero
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
checkpoint signing is off, loudly logged at boot, and every verification
reports **unsigned** — never "verified". Retention on a keyless install
(`RECEIPT_RETENTION_DAYS`, default 90) removes early rows by age; both
verifiers then report the removed prefix as "not anchored: no signing key",
which is information, not a break (#1568).

**Set `AUDIT_ANCHOR_PATH` if tail truncation matters to you.** An admin who
deletes the newest receipts *and* their rows in `audit_checkpoints` leaves
nothing inside the database that proves the rows ever existed. The anchor
file does: the server compares it with `audit_checkpoints` on every verify,
the checkpoint worker refuses to sign while an anchored checkpoint is
missing from the database, and the offline verifier compares it with
`--anchor` (#1565). A database checkpoint the anchor lacks is not a finding
(appending is best-effort, and the path may have been set later); an
anchored checkpoint the database lacks always is. The worker creates the
file at boot, so with signing on a missing or unreadable file is a finding
(`unavailable`). Lines that are not anchor records — a write torn by a
crash — are counted and ignored, and offline, records signed after the
export was taken are skipped. One anchor file belongs to one database: after restoring an empty or
older database, start a new anchor file, or every verify reports the old
anchored checkpoints as missing and the worker will not sign until the head
passes them.

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
certified row vanished — inside the range or above the newest entry, after
the newest rows were deleted and the head rolled back
(`orphaned_checkpoint`, #1566) — with a key in use, a chain no signed
checkpoint certifies because `audit_checkpoints` was emptied
(`no_signed_checkpoint`, #1565), a reaped prefix no checkpoint vouches for
while a key is in use (`unanchored_prefix`), and, with `--anchor`, an
anchored checkpoint missing from or changed in the export
(`anchor_checkpoint_missing`, `anchor_mismatch`) or anchored beyond the
newest entry (`anchor_beyond_export`).

A retention-removed prefix counts as anchored when any signature-valid
checkpoint certifies a surviving entry — the first survivor's `prev_hash`
is an input to every later entry hash. No checkpoint has to sit exactly at
the reap boundary; the server and the offline tool use this one rule
(#1567). The reaper deletes only rows *below* the newest checkpoint, so
the certified row itself always survives.

The checkpoint worker signs only a head that is a stored row, not below
the highest head its process has read, while the newest checkpoint it
signed is still stored unchanged, and while no anchored checkpoint is
missing. It and the reaper count only signature-valid checkpoints, so a
junk row at a huge seq can neither stop signing nor widen what retention
deletes.

Defence in depth (0064): triggers reject deleting, updating or truncating
`audit_checkpoints`, and truncating `audit_stream_heads`, moving its
`head_seq` backwards or changing its hash without its seq. The table owner
(usually the app role) can drop or disable them, which is why the anchor
and the verifiers are the proof, not the triggers.

## What a green verdict proves — and what it does not

**Proves:** every surviving chained row is byte-identical to what was
recorded, in order, with no removals inside the verified range; the signed
checkpoints match the stored chain; a retention-removed prefix is anchored
(a signature-valid checkpoint in the surviving range transitively covers
the first survivor's back-link); the recorded stream head agrees with the
stored rows and with every checkpoint (a wiped table, or a tail truncated
while its checkpoints are kept, is never green); with a key, at least one
signed checkpoint certifies the stored chain; with an anchor, every
anchored checkpoint is still in the database unchanged; and — the
laundering rule — no reaped row sits above a checkpoint younger than the
retention window, which would prove it was created inside the window and
deleted early (`premature_deletion`).

**Does not prove:** without `AUDIT_ANCHOR_PATH` (or without `--anchor`
offline), anything about rows above the newest checkpoint the admin keeps.
An admin who deletes checkpoints can delete or rewrite every row above the
newest one left (the chain hash is unkeyed, so rewritten rows can carry
correct hashes) and move the head to match; inside the database that state
is indistinguishable from a shorter or different chain. While the
middleware that signed the deleted checkpoints keeps running, its witness
reports it and the worker refuses to sign the result; after a restart only
the anchor remembers. Also not proved: turns the middleware never wrote (a compromised
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
