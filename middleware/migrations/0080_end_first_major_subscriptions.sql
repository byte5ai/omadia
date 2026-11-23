-- #2089 / #2067 (K6, the contract step): the first major of the message
-- subscription is gone.
--
-- A subscription without a process (`process_id IS NULL`) belonged to
-- `conversationMessages@1`: one per agent and conversation, always reading
-- every message. Since 0075 a facilitation reads through a subscription of
-- its own process. No service takes, reads or ends a subscription without a
-- process any more, so one that is still active would keep an identity
-- reading a conversation with nobody behind it. End them. The rows stay for
-- the grace period, like every ended subscription.

UPDATE conversation_message_subscriptions
   SET ended_at = now()
 WHERE ended_at IS NULL AND process_id IS NULL;
