-- Spec 2042 §5.4 "One authorization" (#2047) — rollout of 0097 for the agent
-- discussions that are configured today.
--
-- Since 0097 a discussion between two agents needs, on top of the #1018
-- switches (`agents.agent_to_agent = 'on'` and an enabled
-- `agent_channel_policies` row for the chat, 0058), consultation grants in
-- both directions that cover the chat's channel type, and both agents'
-- `may_consult` and `consultable`. Without this backfill every discussion an
-- operator enabled before would stop the moment 0097 lands.
--
-- So: for every two live, non-facilitator agents that are both switched on
-- for agent-to-agent talk AND both enabled in the same chat, grant the pair in
-- both directions, scoped to the channel types of the chats they share, with
-- nothing else (no capabilities, memory `none`, disclosure `{}` = `none`,
-- default budgets), and switch on both agents' consultation switches. That is
-- the least a running discussion needs; it gives no agent access to anything
-- through a colleague (the envelope is still grant ∩ both agents' grants, and
-- the grant names no capability).
--
-- Side effect, by design: the same grants let the two agents `consult` each
-- other in those channel types. The operator sees and revokes them on the
-- agent page like any other grant.
--
-- An existing grant is left as it is (an operator's choice wins). The schema CI
-- gate applies every file twice; the second run finds the rows and changes
-- nothing. The migration runner applies a file once per database, so a grant an
-- operator revokes later does not come back.

WITH enabled AS (
  SELECT p.channel_type, p.channel_key, a.id AS agent_id
    FROM agent_channel_policies p
    JOIN agents a ON a.id = p.agent_id
   WHERE p.agent_to_agent = true
     AND a.agent_to_agent = 'on'
     AND (to_jsonb(a) ->> 'deleted_at') IS NULL
     AND COALESCE(to_jsonb(a) ->> 'archetype', 'standard') <> 'facilitator'
),
pairs AS (
  SELECT x.agent_id AS from_agent_id,
         y.agent_id AS to_agent_id,
         array_agg(DISTINCT x.channel_type ORDER BY x.channel_type) AS channel_scope
    FROM enabled x
    JOIN enabled y
      ON y.channel_type = x.channel_type
     AND y.channel_key = x.channel_key
     AND y.agent_id <> x.agent_id
   GROUP BY x.agent_id, y.agent_id
)
INSERT INTO agent_consultation_grants (from_agent_id, to_agent_id, channel_scope, created_by)
SELECT from_agent_id, to_agent_id, channel_scope, 'migration:0100'
  FROM pairs
ON CONFLICT (from_agent_id, to_agent_id) DO NOTHING;

UPDATE agents a
   SET may_consult = true,
       consultable = true
 WHERE (NOT a.may_consult OR NOT a.consultable)
   AND EXISTS (
     SELECT 1 FROM agent_consultation_grants g
      WHERE g.created_by = 'migration:0100'
        AND (g.from_agent_id = a.id OR g.to_agent_id = a.id)
   );

-- rollback:
--   DELETE FROM agent_consultation_grants WHERE created_by = 'migration:0100';
--   (the switches stay on; they do nothing without a grant)
