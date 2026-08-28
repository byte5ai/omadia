-- #758 — tamper-evident receipt chain: hash chaining + signed checkpoints.
--
-- Builds directly on `turn_receipts` (0039, #757). Every receipt row joins a
-- per-stream hash chain: `entry_hash = sha256(canonical(payload) || prev_hash
-- || seq)`. Editing row n breaks the match stored in row n+1 — the chain
-- visibly breaks for every later entry. Periodic Ed25519 checkpoints sign
-- (stream, seq, head_hash) with a key held OUTSIDE the database, so the
-- whole chain cannot be silently rewritten either.
--
-- Threat model: DETECTION of after-the-fact modification, not prevention.
-- Wholesale destruction shows as seq gaps + orphaned checkpoints.
--
-- Retention interplay: the reaper (#757) legitimately DELETEs expired rows,
-- so DELETE stays allowed and deletions are detectable (seq gaps below the
-- oldest surviving row are expected exactly up to the retention horizon).
-- UPDATE is never legitimate on this table — blocked by trigger below
-- (defence in depth: an admin can drop the trigger; the chain is the proof).
--
-- Rows written before this migration (or while chaining was not yet active)
-- have NULL chain columns — the "pre-chain era", which a verifier reports as
-- unverifiable rather than broken.
--
-- Numbering: 0039 = #757 (turn_receipts), 0040 = #760 (privacy_miss_reports).

ALTER TABLE turn_receipts
  ADD COLUMN IF NOT EXISTS stream_id    TEXT,
  ADD COLUMN IF NOT EXISTS seq          BIGINT,
  ADD COLUMN IF NOT EXISTS prev_hash    BYTEA,
  ADD COLUMN IF NOT EXISTS entry_hash   BYTEA,
  ADD COLUMN IF NOT EXISTS hash_version SMALLINT;

CREATE UNIQUE INDEX IF NOT EXISTS turn_receipts_stream_seq
  ON turn_receipts (stream_id, seq);

-- Serialization point for chain appends: one row per stream, locked
-- FOR UPDATE inside the insert transaction so concurrent appends line up
-- into a single linear chain (no forks).
CREATE TABLE IF NOT EXISTS audit_stream_heads (
  stream_id  TEXT PRIMARY KEY,
  head_seq   BIGINT NOT NULL,
  head_hash  BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the receipts head at genesis (review H1): `SELECT … FOR UPDATE` on a
-- row that does not exist locks NOTHING, so on a fresh deployment two
-- concurrent FIRST appends would both compute seq=1 and the loser's receipt
-- would be permanently lost on the unique index. With the row pre-seeded the
-- lock always has something to grab. head_seq 0 + the genesis hash keep the
-- store's `seq = head_seq + 1` arithmetic identical.
-- The literal is sha256('genesis:receipts') — reproduce with:
--   node -e "console.log(require('node:crypto').createHash('sha256').update('genesis:receipts','utf-8').digest('hex'))"
-- (hard-coded rather than pgcrypto's digest() so the migration needs no extension).
INSERT INTO audit_stream_heads (stream_id, head_seq, head_hash)
VALUES ('receipts', 0, '\xb69452622fd89eb75373337022abd13f81da4da98bdad81955868609bbe42ac2')
ON CONFLICT (stream_id) DO NOTHING;

-- Signed checkpoints: Ed25519 over (stream_id, seq, head_hash, signed_at).
-- The private key lives in env/secret manager, NEVER in this database —
-- otherwise the admin we defend against could re-sign a rewritten chain.
CREATE TABLE IF NOT EXISTS audit_checkpoints (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id              TEXT NOT NULL,
  seq                    BIGINT NOT NULL,
  head_hash              BYTEA NOT NULL,
  signed_at              TIMESTAMPTZ NOT NULL,
  signature              BYTEA NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  UNIQUE (stream_id, seq)
);

-- Defence in depth, not the proof: UPDATE is never legitimate on receipts.
CREATE OR REPLACE FUNCTION turn_receipts_forbid_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'turn_receipts is append-only: UPDATE is forbidden (#758)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS turn_receipts_no_update ON turn_receipts;
CREATE TRIGGER turn_receipts_no_update
  BEFORE UPDATE ON turn_receipts
  FOR EACH ROW EXECUTE FUNCTION turn_receipts_forbid_update();
