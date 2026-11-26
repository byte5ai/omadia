-- ── #1986 (ADR-0187): who and which chat a generated file belongs to ─────────
-- Office exports and rendered diagrams live in an S3-compatible bucket under
-- content-addressed keys; nothing linked a key to a person or a chat, so no
-- chat deletion, user purge or full purge removed them.
--
-- One row per (key, producer, person, chat): the same bytes produced in two
-- chats share one object and get two rows. A release (chat deleted, person
-- purged, everything purged) drops the matching rows; a key left without any
-- row is deleted through the producing plugin. A missing person or chat is
-- stored as '' (the primary key cannot hold NULL).
CREATE TABLE IF NOT EXISTS generated_objects (
  storage_key           text        NOT NULL,
  producer              text        NOT NULL,
  owner_omadia_user_id  text        NOT NULL DEFAULT '',
  scope                 text        NOT NULL DEFAULT '',
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (storage_key, producer, owner_omadia_user_id, scope)
);

CREATE INDEX IF NOT EXISTS generated_objects_owner_idx
  ON generated_objects (owner_omadia_user_id) WHERE owner_omadia_user_id <> '';

CREATE INDEX IF NOT EXISTS generated_objects_scope_idx
  ON generated_objects (scope) WHERE scope <> '';
