-- #2316 (ADR-0279) — the session scope of the conversation a routine was
-- created in (`teams-…`, `<channelId>::<conversationId>`, …). A channel turn in
-- that conversation gets the routine's recent deliveries as conversation
-- context, as the web chat does since ADR 0244. NULL for routines created
-- before this migration and for web routines (the web chat reads its own
-- document).
ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS origin_scope TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_routines_origin_scope
  ON routines (origin_scope)
  WHERE origin_scope IS NOT NULL;
