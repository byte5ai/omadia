-- #1879 — bindings the agents page stored under the guessed channel type
-- `channel-api`. The Public API channel routes under its plugin id
-- `@omadia/channel-api` (ADR-0141: the channel key is `key:<uuid>`), so such
-- a row never matched a turn: the API key kept going to the default agent
-- while the agent card showed the binding.
--
-- Rewritten only where that is unambiguous: the key has the API channel's
-- `key:` form and no `@omadia/channel-api` row holds the same key. Where one
-- does, that row is the binding that has been routing all along and the
-- `channel-api` row stays as it is; the channels page lists it as a stale
-- row the operator can remove. Rows of any other key form are left alone.
UPDATE channel_bindings AS cb
   SET channel_type = '@omadia/channel-api'
 WHERE cb.channel_type = 'channel-api'
   AND cb.channel_key LIKE 'key:%'
   AND NOT EXISTS (
     SELECT 1
       FROM channel_bindings AS real
      WHERE real.channel_type = '@omadia/channel-api'
        AND real.channel_key = cb.channel_key
   );

-- rollback: none needed; the rewritten rows were inert under the old type.
