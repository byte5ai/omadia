-- OB-49 Step a — local-password user accounts + provider-aware identity.
--
-- Rows model "this is a user identified via provider X". The same human can
-- exist multiple times (one row per provider) until V1.x adds explicit
-- account-linking. For V1 we treat each (provider, provider_user_id) as a
-- distinct identity to keep the migration simple and the cookie-claims
-- unambiguous.
--
-- The `password_hash` column is NULLable on purpose: it only carries a value
-- for `provider = 'local'`. OIDC-provided users (entra/google/...) read the
-- identity from their idp's id_token and never store a hash here.
--
-- Idempotent — every CREATE has IF NOT EXISTS, the trigger uses CREATE OR
-- REPLACE plus a guarded CREATE TRIGGER that skips on re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id              UUID         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lower-cased canonical email. Unique within (provider, email) — same
  -- person can land in multiple provider rows but never duplicated within
  -- one provider.
  email           TEXT         NOT NULL,
  -- Provider id matches AuthProvider.id ('local' | 'entra' | future plugin).
  provider        TEXT         NOT NULL,
  -- Stable per-provider identifier. For 'local' this equals email; for
  -- OIDC providers it's the idp's `sub`/`oid` claim. Insulates us from
  -- email churn at the idp.
  provider_user_id TEXT        NOT NULL,
  -- argon2id hash. NULL when provider != 'local'.
  password_hash   TEXT,
  display_name    TEXT         NOT NULL DEFAULT '',
  role            TEXT         NOT NULL DEFAULT 'admin',
  -- Soft-disable without dropping the row (preserves audit trail of who
  -- was admin when an old log line referenced them).
  status          TEXT         NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ,
  CONSTRAINT users_role_chk    CHECK (role IN ('admin')),
  CONSTRAINT users_status_chk  CHECK (status IN ('active', 'disabled')),
  CONSTRAINT users_local_pwd   CHECK (provider <> 'local' OR password_hash IS NOT NULL)
);

-- Per-provider unique index on the stable identifier.
CREATE UNIQUE INDEX IF NOT EXISTS users_provider_user_unique
  ON users (provider, provider_user_id);

-- Per-provider unique on canonical email so two locally-registered users
-- can't grab the same login. Cross-provider duplicates ARE allowed (an
-- entra-bound user can also have a local password row in V1.x linking).
CREATE UNIQUE INDEX IF NOT EXISTS users_provider_email_unique
  ON users (provider, LOWER(email));

CREATE INDEX IF NOT EXISTS users_email_lower_idx
  ON users (LOWER(email));

CREATE INDEX IF NOT EXISTS users_status_idx
  ON users (status) WHERE status <> 'active';

-- updated_at auto-bump on UPDATE. Generic helper: skip-if-already-defined
-- guarded by the CREATE OR REPLACE so reruns don't drift behaviour.
CREATE OR REPLACE FUNCTION users_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'users_set_updated_at_trg'
  ) THEN
    CREATE TRIGGER users_set_updated_at_trg
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION users_set_updated_at();
  END IF;
END $$;
