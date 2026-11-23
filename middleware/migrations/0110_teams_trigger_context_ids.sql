-- Spec 2042 (G2 follow-up): Teams trigger contexts named their conversation.
--
-- Before this release `conversationIdOf` read a Bot Framework reference's
-- top-level `channelId` ('msteams') before `conversation.id`, so every Teams
-- trigger was stored under the context `teams:msteams`: all Teams chats shared
-- one context, `list_triggers` in any of them listed the agent's triggers of
-- every other Teams chat, and context activity/end were booked on that one key.
-- The code now keys on the conversation id. This rewrites the stored rows so
-- existing triggers find their conversation again.
--
-- A row whose reference carries no conversation id cannot be placed; it keeps
-- the old key and simply matches no conversation (it can still be cancelled by
-- an operator and ends at its deadline).

UPDATE agent_triggers
   SET context_id = 'teams:' || (delivery_ref -> 'conversation' ->> 'id')
 WHERE context_id = 'teams:msteams'
   AND context_kind IN ('conversation', 'meeting')
   AND COALESCE(delivery_ref -> 'conversation' ->> 'id', '') <> '';

-- The shared activity row cannot be split per conversation: drop it. The next
-- message in each Teams conversation books its own row again; until then a
-- trigger reads "no activity known", which its checks already handle.
DELETE FROM agent_trigger_context_activity
 WHERE context_id = 'teams:msteams'
   AND context_kind IN ('conversation', 'meeting');
