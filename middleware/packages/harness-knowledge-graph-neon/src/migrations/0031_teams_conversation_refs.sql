-- ── teams_conversation_refs: canonical home + per-bot scoping ──────────────
-- (multi-agent Teams identities epic, byte5ai/omadia#860 / channel-teams#17)
--
-- Two things at once, both deliberate:
--
-- 1. RESCUE. The table's original DDL shipped 2026-08-23 (#841) as
--    src/services/graph/migrations/0009_teams_conversation_refs.sql — a
--    directory nothing applies anymore: graph migrations were consolidated
--    into THIS package's single ordered series (see the root Dockerfile's
--    "Graph migrations now live inside the @omadia/knowledge-graph-neon
--    plugin package" note), and the KG-neon migrator only scans its own
--    dist/migrations. Deployments therefore never created the table, and the
--    Teams plugin's write-through reference store silently degraded to its
--    pre-#330 cache-only behaviour (that store is best-effort by design, so
--    nothing ever threw). The CREATE below is the same shape, now in the
--    series that actually runs; the legacy file is deleted in the same
--    commit.
--
-- 2. MULTI-BOT SCOPING. The Teams channel is gaining N bot identities.
--    References must be keyed per bot or proactive sends cross between bots
--    (bot A presenting bot B's credentials to continueConversationAsync).
--    `bot_app_id = ''` denotes the legacy/default bot: single-bot
--    deployments keep byte-identical behaviour, and the NOT NULL DEFAULT
--    doubles as the backfill for any pre-existing rows.
--
-- Idempotency: CREATE and ADD COLUMN are guarded; the DO block re-keys the
-- primary key only while the legacy single-column key is still in place, so
-- a second apply is a no-op (the runner's advisory lock serialises replicas,
-- but a guarded re-key also survives a manually pre-created table).

CREATE TABLE IF NOT EXISTS teams_conversation_refs (
  conversation_id TEXT NOT NULL,
  bot_app_id      TEXT NOT NULL DEFAULT '',
  ref             JSONB NOT NULL,
  teams_type      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, bot_app_id)
);

-- Legacy-shape upgrade: a table created by hand or by the orphaned 0009 file
-- has no bot_app_id column and a single-column primary key.
ALTER TABLE teams_conversation_refs
  ADD COLUMN IF NOT EXISTS bot_app_id TEXT NOT NULL DEFAULT '';

DO $$
DECLARE
  pk_cols int;
BEGIN
  SELECT array_length(conkey, 1) INTO pk_cols
  FROM pg_constraint
  WHERE conrelid = 'teams_conversation_refs'::regclass
    AND contype = 'p';

  IF pk_cols = 1 THEN
    ALTER TABLE teams_conversation_refs
      DROP CONSTRAINT teams_conversation_refs_pkey;
    ALTER TABLE teams_conversation_refs
      ADD PRIMARY KEY (conversation_id, bot_app_id);
  END IF;
END
$$;
