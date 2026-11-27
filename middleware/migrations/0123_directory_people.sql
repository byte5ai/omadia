-- #2335 / ADR-0300 — the Entra-fed directory of people.
--
-- A directory person is NOT an account (`users` holds web logins, and every
-- account is an administrator, ADR-0113). A person anchors channel identities
-- and per-person tokens: their key is the AAD object id (`external_id`), the
-- same value an Entra web login carries as session `sub`.
--
-- The rows are written only by the kernel's directory sync from a source a
-- channel plugin contributes (Teams: Graph `/users/delta`).
CREATE TABLE IF NOT EXISTS directory_people (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source            text NOT NULL CHECK (source IN ('entra')),
  tenant_id         text NOT NULL,
  external_id       text NOT NULL,
  upn               text,
  mail              text,
  display_name      text NOT NULL DEFAULT '',
  account_enabled   boolean NOT NULL DEFAULT true,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprovisioned')),
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  synced_at         timestamptz NOT NULL DEFAULT now(),
  -- the full read that last contained this person (deprovisioning of people a
  -- completed full read no longer lists compares against it)
  seen_in_run       uuid,
  deprovisioned_at  timestamptz,
  -- a deprovisioning whose token revocation failed for some server; retried
  -- at the start of every sync run of the tenant until it succeeds
  revoke_pending    boolean NOT NULL DEFAULT false,
  UNIQUE (source, tenant_id, external_id)
);

CREATE INDEX IF NOT EXISTS directory_people_external_idx ON directory_people (external_id);
CREATE INDEX IF NOT EXISTS directory_people_name_idx ON directory_people (LOWER(display_name));

-- One row per (source, tenant): the stored delta cursor and the last outcome.
CREATE TABLE IF NOT EXISTS directory_sync_state (
  source             text NOT NULL,
  tenant_id          text NOT NULL,
  delta_cursor       text,
  last_started_at    timestamptz,
  last_completed_at  timestamptz,
  last_full_at       timestamptz,
  last_error         text,
  PRIMARY KEY (source, tenant_id)
);

-- rollback: DROP TABLE directory_sync_state; DROP TABLE directory_people;
