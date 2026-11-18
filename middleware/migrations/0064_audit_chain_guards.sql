-- #1565 / #1566 — defence in depth for the receipt chain's bookkeeping tables.
--
-- 0041 guarded only `turn_receipts` against UPDATE. The two tables that make
-- tail truncation detectable accepted any change: rows in `audit_checkpoints`
-- could be deleted and `audit_stream_heads.head_seq` could be moved
-- backwards, which together hid the deletion of the newest receipts.
--
-- Neither change is ever legitimate: checkpoints are written once and never
-- reaped (the retention reaper only touches `turn_receipts`), and a stream
-- head only moves forward, and a head's hash changes only together with
-- its seq. Row triggers do not fire on TRUNCATE, so each table also gets a
-- statement-level TRUNCATE guard. Like `turn_receipts_no_update`, these
-- triggers are not the proof — the table owner (usually the app role) can
-- drop or disable them. The proof is the external anchor file
-- (`AUDIT_ANCHOR_PATH`), which both verifiers now compare.

CREATE OR REPLACE FUNCTION audit_checkpoints_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_checkpoints is append-only: % is forbidden (#1565)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_checkpoints_append_only ON audit_checkpoints;
CREATE TRIGGER audit_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION audit_checkpoints_forbid_change();

DROP TRIGGER IF EXISTS audit_checkpoints_no_truncate ON audit_checkpoints;
CREATE TRIGGER audit_checkpoints_no_truncate
  BEFORE TRUNCATE ON audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION audit_checkpoints_forbid_change();

CREATE OR REPLACE FUNCTION audit_stream_heads_forward_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'audit_stream_heads rows cannot be removed: % (#1566)', TG_OP;
  END IF;
  IF NEW.stream_id <> OLD.stream_id THEN
    RAISE EXCEPTION 'audit_stream_heads.stream_id cannot change (#1566)';
  END IF;
  IF NEW.head_seq < OLD.head_seq THEN
    RAISE EXCEPTION 'audit_stream_heads.head_seq only moves forward: % -> % (#1566)',
      OLD.head_seq, NEW.head_seq;
  END IF;
  IF NEW.head_seq = OLD.head_seq AND NEW.head_hash <> OLD.head_hash THEN
    RAISE EXCEPTION 'audit_stream_heads.head_hash cannot change without head_seq (#1566)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_stream_heads_no_rollback ON audit_stream_heads;
CREATE TRIGGER audit_stream_heads_no_rollback
  BEFORE UPDATE OR DELETE ON audit_stream_heads
  FOR EACH ROW EXECUTE FUNCTION audit_stream_heads_forward_only();

DROP TRIGGER IF EXISTS audit_stream_heads_no_truncate ON audit_stream_heads;
CREATE TRIGGER audit_stream_heads_no_truncate
  BEFORE TRUNCATE ON audit_stream_heads
  FOR EACH STATEMENT EXECUTE FUNCTION audit_stream_heads_forward_only();
