-- Store role holders/delegates as session identities (sub/email), not users.id UUIDs, so the
-- operator can assign roles by identity without a users-table join (MVP, mirrors await responder).
-- Forward-only, idempotent.
ALTER TABLE conductor_role_assignments DROP CONSTRAINT IF EXISTS conductor_role_assignments_holder_id_fkey;
ALTER TABLE conductor_role_assignments DROP CONSTRAINT IF EXISTS conductor_role_assignments_delegate_id_fkey;
ALTER TABLE conductor_role_assignments ALTER COLUMN holder_id TYPE TEXT USING holder_id::text;
ALTER TABLE conductor_role_assignments ALTER COLUMN delegate_id TYPE TEXT USING delegate_id::text;
