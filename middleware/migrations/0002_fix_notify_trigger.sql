-- 0002_fix_notify_trigger.sql
--
-- Fix notify_agents_changed: plpgsql binds `NEW.agent_id` references at
-- trigger-execution time; the original `COALESCE(NEW.agent_id::text,
-- NEW.id::text)` blew up with "record 'new' has no field 'agent_id'" the
-- moment we inserted into `agents` (which has `id` only). Branch by
-- TG_TABLE_NAME so each row-shape touches only its real columns.

CREATE OR REPLACE FUNCTION notify_agents_changed() RETURNS trigger AS $$
DECLARE
  payload TEXT;
BEGIN
  IF TG_TABLE_NAME = 'multi_orchestrator_settings' THEN
    payload := 'platform';
  ELSIF TG_TABLE_NAME = 'agents' THEN
    IF TG_OP = 'DELETE' THEN
      payload := OLD.id::text;
    ELSE
      payload := NEW.id::text;
    END IF;
  ELSE
    -- agent_plugins, channel_bindings — both carry agent_id
    IF TG_OP = 'DELETE' THEN
      payload := OLD.agent_id::text;
    ELSE
      payload := NEW.agent_id::text;
    END IF;
  END IF;
  PERFORM pg_notify('agents_changed', payload);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
