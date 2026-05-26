BEGIN;

-- Slice 6.5 — extend memory_acl_audit.action CHECK to allow the new
-- 'edit_excerpt' action. The Zod AclAction enum in @omadia/plugin-api
-- already gained 'edit_excerpt'; this migration brings the database
-- column in line.
--
-- Pure additive: the existing five values stay valid. No data backfill
-- — every pre-existing row falls into the prior set.

ALTER TABLE memory_acl_audit
  DROP CONSTRAINT IF EXISTS memory_acl_audit_action_chk;

ALTER TABLE memory_acl_audit
  ADD CONSTRAINT memory_acl_audit_action_chk CHECK (
    action IN ('create', 'expand', 'shrink', 'delete', 'edit', 'edit_excerpt')
  );

COMMIT;
