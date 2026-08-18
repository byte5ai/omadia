-- ── Audience-floor prohibitions (#575, spec §5.2 "allowlist ∩, denylist ∪") ──
-- Migration 0035 stored what a principal MAY do. This stores what a principal
-- must NOT be party to — a different kind of statement, and one that behaves
-- differently at every level:
--
--   * a grant is intersected across the audience (the room may do what everyone
--     may do), a denial is UNIONED (one participant's prohibition binds the
--     whole room);
--   * a grant is additive, a denial OVERRIDES — it is subtracted after the
--     intersection, so an unrelated role assignment cannot silently lift an
--     operator's explicit "this person must never do X".
--
-- Separate tables rather than an `effect` column on 0035's:
--
--   * the two are read on different code paths and unioned/intersected
--     differently, so a shared table would need the discriminator in every
--     query and in the primary key;
--   * 0035 already ships, and widening a live table's primary key is a worse
--     migration than adding two new ones;
--   * a schema in which "grant" and "deny" are visibly different things is
--     harder to confuse than one where they differ by a string column — and
--     confusing them is a permission bug in the dangerous direction.
--
-- No foreign key to conductor_roles(key), for the same reason as 0035: #333
-- phase 2 lets role membership come from an external directory this deployment
-- holds no local row for.

CREATE TABLE IF NOT EXISTS audience_direct_denials (
  principal_kind TEXT        NOT NULL,
  principal_ref  TEXT        NOT NULL,
  capability     TEXT        NOT NULL,
  denied_by      TEXT        NOT NULL,
  denied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_kind, principal_ref, capability)
);

CREATE TABLE IF NOT EXISTS audience_role_denials (
  role_key   TEXT        NOT NULL,
  capability TEXT        NOT NULL,
  denied_by  TEXT        NOT NULL,
  denied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_key, capability)
);

-- rollback: DROP TABLE audience_role_denials; DROP TABLE audience_direct_denials;
