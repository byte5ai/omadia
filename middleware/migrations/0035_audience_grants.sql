-- ── Audience-floor capability grants (#575 phase 2) ────────────────────────
-- The durable backing for `GrantStore`. Until now the only implementation was
-- `InMemoryGrantStore`, which means a deployment that switched the audience
-- floor on lost every grant on restart — and because the floor fails closed, an
-- empty grant table is not "no policy", it is "nobody may do anything". A
-- restart therefore did not degrade the feature, it shut the rooms.
--
-- Two tables rather than one with a nullable discriminator: a direct grant and
-- a role grant are looked up by different keys on different code paths
-- (`directGrants(principal)` vs `roleGrants(roleKey)`), and the SDK keeps them
-- separate for exactly that reason. One table with a half-empty key column
-- would need a partial index per path and could express a row that is neither.
--
-- Capability strings are opaque here on purpose. The floor intersects sets of
-- them; what they mean (`tool:send_email`, `memory:recall`, `attachment:read`)
-- is the guards' business, and a CHECK constraint listing today's namespaces
-- would have to be migrated every time a guard learns a new one.

-- ---------------------------------------------------------------------------
-- Direct grants: a Principal holds a capability in their own right.
--
-- `principal_kind` is always 'user' today — `resolveCapabilities` refuses a
-- `role:` principal outright, because a role is an indirection over holders and
-- not a subject with entitlements. The column exists anyway so the table does
-- not have to be migrated if #333 ever grows a third kind; a row with any other
-- kind is simply never read.
--
-- `principal_ref` holds the CANONICAL form (`canonicalizePrincipalRef`), which
-- for a user means lower-cased. Writing the raw form here would let the same
-- person miss their own grants depending on how a channel spelled their id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audience_direct_grants (
  principal_kind TEXT        NOT NULL,
  principal_ref  TEXT        NOT NULL,
  capability     TEXT        NOT NULL,
  granted_by     TEXT        NOT NULL,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_kind, principal_ref, capability)
);

-- ---------------------------------------------------------------------------
-- Role grants: everyone who currently holds the role holds the capability.
--
-- DELIBERATELY NO FOREIGN KEY to conductor_roles(key).
--
-- #333 phase 2 made role membership answerable by a registry of sources, and a
-- source may be an external directory this deployment has no local row for. A
-- foreign key would make "grant a capability to the Entra group everyone in
-- support belongs to" unrepresentable — the exact case the role-source registry
-- exists to serve. The cost is that a typo'd role key is accepted and silently
-- grants nothing; that fails in the safe direction, and the admin surface lists
-- what is stored so the typo is visible.
--
-- Role keys keep their case: `conductor_roles.key` is written verbatim by
-- `createRole`, so lower-casing here would miss every mixed-case role.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audience_role_grants (
  role_key   TEXT        NOT NULL,
  capability TEXT        NOT NULL,
  granted_by TEXT        NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_key, capability)
);

-- The hot path reads every capability for one key, which the primary key's
-- leading column already serves. No secondary index is added for it.

-- rollback: DROP TABLE audience_role_grants; DROP TABLE audience_direct_grants;
