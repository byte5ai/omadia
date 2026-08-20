-- ── Credential keychain: credentials + grants (#578 phase 1) ───────────────
-- The durable backing for `CredentialStore` (`@omadia/channel-sdk`). Mirrors
-- the conventions `audience_direct_grants`/`audience_role_grants` (0035) and
-- `attachment_scope_bindings` (0036) established: principal references are
-- stored as a (kind, ref) pair rather than one formatted string (the two
-- kinds canonicalise differently — user lower-cased, role case-preserved —
-- and comparing formatted strings would let that distinction leak), and this
-- table does not FK against `conductor_roles` for the same reason the audience
-- grants tables don't: a role source may be an external directory this
-- deployment has no local row for.
--
-- 0038 is reserved for the Satellites epic (#746); 0039 is turn_receipts
-- (#757); this series continues at 0040.

-- ---------------------------------------------------------------------------
-- credentials: encrypted, fingerprinted, owned by a principal (or org-wide).
--
-- `owner_kind`/`owner_ref` are NULL for a `service` credential (org-wide,
-- broker-only) and required for `personal` (asked-for, per #578 phase 3). The
-- CHECK constraint enforces that pairing at the database layer as a second
-- line of defence behind the store's own `NewCredentialInput` validation —
-- belt and braces, because a credential with an ambiguous owner is exactly
-- the kind of row a future migration or a hand-written INSERT could otherwise
-- produce.
--
-- Secret material (`enc_iv`/`enc_tag`/`enc_ciphertext`) is AES-256-GCM,
-- encrypted before this row is ever written — see
-- `middleware/src/credentials/crypto.ts`. `fingerprint` is a one-way,
-- truncated SHA-256 digest safe to display in the admin surface and audit
-- events in place of the secret itself.
--
-- Broker declaration columns (`broker_*`) are populated only for `service`
-- credentials. Phase 1 stores them; nothing reads or enforces them yet — the
-- egress check (host/method/path-prefix, fail-closed) is phase 2.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credentials (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('personal', 'service')),
  owner_kind               TEXT,
  owner_ref                TEXT,
  fingerprint              TEXT NOT NULL,
  enc_iv                   TEXT NOT NULL,
  enc_tag                  TEXT NOT NULL,
  enc_ciphertext           TEXT NOT NULL,
  broker_host              TEXT,
  broker_injection_scheme  TEXT,
  broker_injection_key     TEXT,
  broker_allowed_methods   TEXT[],
  broker_path_prefixes     TEXT[],
  created_by               TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at               TIMESTAMPTZ,
  revoked_by               TEXT,
  CONSTRAINT credentials_owner_matches_kind CHECK (
    (kind = 'personal' AND owner_kind IS NOT NULL AND owner_ref IS NOT NULL)
    OR (kind = 'service' AND owner_kind IS NULL AND owner_ref IS NULL)
  )
);

-- One live (non-revoked) credential per name. A revoked credential's name may
-- be reused — revocation is not deletion, so the old row stays for audit
-- history while a fresh credential can take the freed name.
CREATE UNIQUE INDEX IF NOT EXISTS credentials_name_live
  ON credentials (name)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- credential_grants: one principal's right to use one credential.
--
-- `mode` is `once` (single-use, `expires_at` mandatory — enforced by the CHECK
-- below) or `standing` (repeatable, `expires_at` optional). `consumed_at` is
-- written once by a `once` grant's first successful broker use (phase 2/3);
-- the column exists now so those phases need no further migration.
--
-- Expiry is compared against a caller-supplied `now`, never `now()` evaluated
-- server-side against the row's own timestamps — the store layer
-- (`isGrantActive` / `CredentialStore.activeGrant`) is the single place that
-- decides "active", precisely so the #709/#710 anchor-on-the-same-row race
-- cannot recur here: every reader pins one instant and evaluates every grant
-- against it, rather than each row racing against its own clock read.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credential_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id  UUID NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  principal_kind TEXT NOT NULL,
  principal_ref  TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('once', 'standing')),
  purpose        TEXT NOT NULL CHECK (length(trim(purpose)) > 0),
  granted_by     TEXT NOT NULL,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,
  consumed_at    TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoked_by     TEXT,
  CONSTRAINT credential_grants_once_has_expiry CHECK (mode = 'standing' OR expires_at IS NOT NULL)
);

-- Hot path: "does this principal have an active grant for this credential" —
-- the broker's per-request check (phase 2).
CREATE INDEX IF NOT EXISTS credential_grants_lookup
  ON credential_grants (credential_id, principal_kind, principal_ref);

-- Admin surface: every grant for a credential, or every grant a principal
-- holds (phase 4).
CREATE INDEX IF NOT EXISTS credential_grants_by_credential
  ON credential_grants (credential_id);
CREATE INDEX IF NOT EXISTS credential_grants_by_principal
  ON credential_grants (principal_kind, principal_ref);

-- rollback: DROP TABLE credential_grants; DROP TABLE credentials;
