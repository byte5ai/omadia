-- ── Open questions of a card posted as plain text (#2086, spec 2042 §5.14) ──
-- A channel that cannot show a question card natively still gets one: the
-- kernel posts the card as numbered text (`renderCardAsText`) and keeps the
-- question here until it closes. A reply to that message that fits the
-- question (`parseCardReply`) becomes the same typed `card_answer` event a
-- card submission would be, so the engine cannot tell the difference.
--
-- One row per posted message. `card` is the validated QuestionCard (exactly
-- one question: a typed reply answers one question). Rows end with the
-- question (`expires_at`: the card's close, else a day after the post) and are
-- pruned when they have; nothing here outlives its conversation's usefulness.
--
-- Idempotent (the CI schema job applies everything twice).

CREATE TABLE IF NOT EXISTS open_card_questions (
  channel_type    TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  -- The platform id of the posted message: what a reply points at, and the
  -- `messageId` of every `card_answer` event for it.
  message_id      TEXT NOT NULL,
  agent_slug      TEXT NOT NULL,
  card_id         TEXT NOT NULL,
  card            JSONB NOT NULL,
  -- A poll went out the same way: its answer is `{ optionId }`, not typed answers.
  as_poll         BOOLEAN NOT NULL DEFAULT false,
  posted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (channel_type, conversation_id, message_id)
);

CREATE INDEX IF NOT EXISTS open_card_questions_conversation_idx
  ON open_card_questions (channel_type, conversation_id, expires_at);

COMMENT ON TABLE open_card_questions IS
  '#2086 a question card posted as plain text; a fitting reply becomes a card_answer event.';
