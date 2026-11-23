-- Rollout defect D34: 0073 gave every row of conductor_ephemeral_attachments
-- the shared conversation reservation, also rows that belonged to nothing
-- that ran: `pending` claims left behind by the old facilitation path. A
-- facilitation could not start in those conversations until the Conductor's
-- reaper got to the rows, and nothing listed them for the operator.
--
-- An agent discussion holds its conversation only while its attachment is
-- alive. Release every discussion reservation that has no attachment whose
-- time has not run out. The Conductor's tables come from its own migrator
-- and may not exist; then no discussion can be running either.

DO $$
BEGIN
  IF to_regclass('conductor_ephemeral_attachments') IS NOT NULL THEN
    UPDATE conversation_reservations r
       SET released_at = now(), release_reason = 'no_running_discussion'
     WHERE r.released_at IS NULL AND r.holder_kind = 'agent_discussion'
       AND NOT EXISTS (
         SELECT 1 FROM conductor_ephemeral_attachments a
          WHERE a.channel_type = r.channel_type AND a.channel_key = r.conversation_id
            AND a.expires_at > now());
  ELSE
    UPDATE conversation_reservations r
       SET released_at = now(), release_reason = 'no_running_discussion'
     WHERE r.released_at IS NULL AND r.holder_kind = 'agent_discussion';
  END IF;
END $$;
