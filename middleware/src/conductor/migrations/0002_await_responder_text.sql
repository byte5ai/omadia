-- Store the responder as the session identity (provider 'sub' / email), not a users.id UUID,
-- so an operator answering a pending await via the UI doesn't require a users-table join.
-- Forward-only, idempotent.
ALTER TABLE conductor_await_responses DROP CONSTRAINT IF EXISTS conductor_await_responses_responder_id_fkey;
ALTER TABLE conductor_await_responses ALTER COLUMN responder_id TYPE TEXT USING responder_id::text;
