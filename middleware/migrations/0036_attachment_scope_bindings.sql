-- ── Attachment handles bound to the room that minted them (#575) ───────────
-- Guard 3 checks the floor at REDEMPTION: may this room redeem a storage
-- handle at all. It could not check the floor at MINTING, so a key issued in a
-- private chat stayed redeemable in any room that happened to hold
-- `attachment:read`. A storage key is just a string, and a string can be
-- pasted somewhere else — that is the gap this table closes.
--
-- One row per storage key, written on FIRST sighting (which is the ingest of
-- the turn the file arrived on) and compared on every later resolution.
--
-- ---------------------------------------------------------------------------
-- Why the scope is stored as two columns rather than one formatted string
-- ---------------------------------------------------------------------------
-- `formatSessionScope` is deliberately lossy in one direction: a `personal`
-- scope renders as `personal:<id>`, and a `conversation` scope renders as its
-- raw conversation id — which could itself literally be the string
-- `personal:<id>`. Comparing formatted strings would let two different kinds of
-- room look like the same room. Kind and reference are therefore kept apart and
-- compared as a pair.
--
-- ---------------------------------------------------------------------------
-- Why only ADDRESSABLE scopes are ever written here
-- ---------------------------------------------------------------------------
-- `ScopeId`'s `unscoped` kind exists because some scope strings identify no
-- room at all: `'http-default'` is shared by every unscoped HTTP caller (the
-- live cross-user hole in #445) and `teams-unknown` by every Teams activity
-- that arrived without a conversation id. Binding a handle to one of those
-- would not restrict anything — it would declare every unrelated caller to be
-- "the same room", which is worse than not binding at all, because it reads as
-- enforcement. `isAddressableScope` is the gate, and a non-addressable scope
-- means this table is not consulted.
--
-- `system` scopes (routines, schedules, the conductor) are non-addressable for
-- the same reason from the other end: there is no room, so there is nothing to
-- bind to.

CREATE TABLE IF NOT EXISTS attachment_scope_bindings (
  storage_key TEXT        PRIMARY KEY,
  scope_kind  TEXT        NOT NULL,
  scope_ref   TEXT        NOT NULL,
  bound_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- rollback: DROP TABLE attachment_scope_bindings;
