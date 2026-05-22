BEGIN;

-- Slice 5 — extend the memory_acl_audit.action CHECK constraint so
-- content-edit rows (`updateMemorableKnowledge`) can land. The Zod
-- AclAction enum in @omadia/plugin-api already gained 'edit'; this
-- migration brings the database column in line.
--
-- Pure additive: the old four values stay valid. No data backfill —
-- existing rows are still in {create, expand, shrink, delete} and
-- match the new constraint.

ALTER TABLE memory_acl_audit
  DROP CONSTRAINT IF EXISTS memory_acl_audit_action_chk;

ALTER TABLE memory_acl_audit
  ADD CONSTRAINT memory_acl_audit_action_chk CHECK (
    action IN ('create', 'expand', 'shrink', 'delete', 'edit')
  );

COMMIT;
