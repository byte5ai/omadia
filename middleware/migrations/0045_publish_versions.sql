-- Issue #581 — publish primitive: immutable versions + a per-app pointer.
--
-- `publish_versions` is insert-only from the application's perspective (see
-- `PublishStore`'s interface, which has no update/delete method) — the
-- primary key `(app_id, version)` is the DB-level backstop for that
-- invariant: a bug that tried to hand out a version number twice fails
-- loudly (unique-violation) instead of silently overwriting a prior
-- publish's recorded content hash/entrypoint.
--
-- `publish_apps` holds the two mutable pieces of state an app has: the
-- counter used to allocate the NEXT version number, and the pointer to
-- whichever version is currently live. The composite foreign key ties the
-- pointer to a real, already-created version row — `rollbackTo` can only
-- ever point at a version that genuinely exists.

CREATE TABLE IF NOT EXISTS publish_versions (
  app_id            TEXT NOT NULL,
  version           INTEGER NOT NULL,
  name              TEXT NOT NULL,
  entrypoint        TEXT NOT NULL,
  dir_hash          TEXT NOT NULL,
  source_scope_key  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, version)
);

CREATE TABLE IF NOT EXISTS publish_apps (
  app_id           TEXT PRIMARY KEY,
  next_version     INTEGER NOT NULL DEFAULT 1,
  current_version  INTEGER,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT publish_apps_current_version_fk
    FOREIGN KEY (app_id, current_version) REFERENCES publish_versions (app_id, version)
);

-- listVersions / the (future) admin version-list view both scan by app_id.
CREATE INDEX IF NOT EXISTS publish_versions_app_id_idx ON publish_versions (app_id);

-- rollback: DROP TABLE publish_apps; DROP TABLE publish_versions;
