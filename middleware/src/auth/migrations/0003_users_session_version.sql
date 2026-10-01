-- Server-side session revocation: a per-user session version.
--
-- The admin session is a stateless JWT. Until this column existed, nothing on
-- the server could end one early: signing out cleared the browser's cookie, an
-- admin password reset only replaced the hash, and a copy of the cookie kept
-- working until its own expiry (and could be renewed up to the absolute cap).
--
-- Every session token now carries the account's `session_version` at mint time
-- (claim `sv`), and `evaluateSessionToken` refuses a token whose `sv` no longer
-- matches this column. Sign-out, an admin password reset and disabling the
-- account bump it (`session_version = session_version + 1`, in the same UPDATE
-- as the change that caused it), which ends every outstanding session of that
-- user at once. Deleting the row needs no bump: a token whose row is gone is
-- refused as well.
--
-- Additive and idempotent: existing rows start at 0, which is also the version
-- a token minted before the claim existed is read as. An older build rolled
-- back onto a migrated database ignores the column.

ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
