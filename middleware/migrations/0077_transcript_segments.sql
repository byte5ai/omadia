-- ── Transcript segments as inbound events (#2089, spec 2043 §5.3) ──────────
-- A live session may deliver what was SAID as text: a transcript segment
-- from an authenticated media source of that session. It is stored like a
-- message, so the engine reads it by event id like every other contribution:
--
--   kind        'transcript_segment'
--   message_id  the stable segment id
--   revision    0 for the first text of a segment, +1 for each corrected one
--   transcript  { sessionId, segmentId, source, speakerHint? }
--               source 'participant': a media channel bound to one
--               participant's account; the author is that principal.
--               source 'shared': a room microphone or mixed stream; no
--               authorship is claimed, `speakerHint` is a hint only.
--
-- No channel produces these yet; this is the contract and its storage.
--
-- Idempotent (the CI schema job applies everything twice).

ALTER TABLE conversation_message_events ADD COLUMN IF NOT EXISTS transcript JSONB;

ALTER TABLE conversation_message_events DROP CONSTRAINT IF EXISTS conversation_message_events_kind_check;
ALTER TABLE conversation_message_events ADD CONSTRAINT conversation_message_events_kind_check
  CHECK (kind IN ('created', 'edited', 'deleted', 'reaction', 'card_answer', 'transcript_segment'));

-- A segment's revisions are counted on their own, apart from messages.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_events_transcript_revision_uq
  ON conversation_message_events (subscription_id, message_id, revision)
  WHERE kind = 'transcript_segment';
