-- Spec 2042 §5.11 / ADR-0019 (#2079) — discretion as information flow control.
--
-- 1. `discretion_labels` — labels persisted transitively: whatever a turn
--    writes (its graph turn `turn`, a memorable `memorable`, a note of the
--    memory tool `memory_file`, keyed by its physical store path) keeps the
--    turn's label set, and reusing it later adds those labels to the new
--    turn. Holds label shapes (context keys, reader ids, source systems,
--    classifications), never content.
-- 2. `integration_readerships` — what the operator declared per integration
--    (a plugin id or `mcp:<serverId>`):
--    - `sensitivity`: `restricted` marks a system whose data reaches no
--      integration whose readership does not accept it;
--    - `readers`: who reads what is written there (`{"kind":"everyone"}` or
--      `{"kind":"set","ids":[…]}`); a row = a declaration, no row = undeclared,
--      and an undeclared integration receives no data from restricted
--      contexts or classified fields;
--    - `accepts_systems`, `accepts_classifications`: restricted sources and
--      classifications that may be written there.
-- 3. `discretion_flow_audit` — every refused and every allowed cross-context
--    flow, with label ids and reasons, never content.
--
-- Idempotent: the schema CI gate applies every file twice.

CREATE TABLE IF NOT EXISTS discretion_labels (
  subject_kind TEXT        NOT NULL,
  subject_id   TEXT        NOT NULL,
  agent_slug   TEXT,
  labels       JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_kind, subject_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'discretion_labels_shape_check'
       AND conrelid = 'discretion_labels'::regclass
  ) THEN
    ALTER TABLE discretion_labels
      ADD CONSTRAINT discretion_labels_shape_check
      CHECK (subject_kind IN ('turn', 'memorable', 'memory_file') AND jsonb_typeof(labels) = 'array');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS integration_readerships (
  integration             TEXT        PRIMARY KEY,
  sensitivity             TEXT        NOT NULL DEFAULT 'internal',
  readers                 JSONB       NOT NULL DEFAULT '{"kind":"everyone"}'::jsonb,
  accepts_systems         TEXT[]      NOT NULL DEFAULT '{}',
  accepts_classifications TEXT[]      NOT NULL DEFAULT '{}',
  updated_by              TEXT        NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'integration_readerships_shape_check'
       AND conrelid = 'integration_readerships'::regclass
  ) THEN
    ALTER TABLE integration_readerships
      ADD CONSTRAINT integration_readerships_shape_check
      CHECK (sensitivity IN ('internal', 'restricted') AND jsonb_typeof(readers) = 'object');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS discretion_flow_audit (
  id          BIGSERIAL   PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  turn_id     TEXT,
  agent_slug  TEXT,
  egress      TEXT        NOT NULL,
  target      TEXT,
  allowed     BOOLEAN     NOT NULL,
  labels      TEXT[]      NOT NULL DEFAULT '{}',
  violations  TEXT[]      NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS discretion_flow_audit_at_idx ON discretion_flow_audit (at);
CREATE INDEX IF NOT EXISTS discretion_flow_audit_turn_idx ON discretion_flow_audit (turn_id);

-- rollback:
--   DROP TABLE discretion_flow_audit;
--   DROP TABLE integration_readerships;
--   DROP TABLE discretion_labels;
