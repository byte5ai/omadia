-- Conductor US5 reminders — align the channel-binding key with the rest of Conductor's identity model.
-- Role holders (conductor_role_assignments.holder_id) and await responders (conductor_await_responses
-- .responder_id) are TEXT (session.sub / email / channel-native id), not UUID. The original
-- conductor_channel_bindings.user_id was UUID, which could never match a holder id. Switch it to TEXT
-- so a reminder can resolve holder -> conversation_ref. The table is empty (no store wrote to it yet),
-- so the type change is safe. Forward-only, idempotent.
ALTER TABLE conductor_channel_bindings ALTER COLUMN user_id TYPE TEXT;
