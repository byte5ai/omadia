-- ── Agent identity: the language an agent speaks (`language`) (#2043) ───────
-- A facilitator is created as a named colleague with a language of its own:
-- a German-speaking team and an English-speaking one can each have theirs on
-- the same instance. The installation-wide `ai_disclosure_locale` is one
-- value for every agent, so it cannot say that.
--
-- BCP 47 tag (`de`, `en`, `de-CH`). NULL = not set: the installation's
-- language applies, exactly as before. The kernel answers a facilitator's
-- fixed refusal in this language and hands it to the facilitation engine with
-- the agent's profile; it changes no stored prompt, so every existing row
-- keeps the prompt it had.
--
-- The CHECK keeps a hand-written row inside the same shape the route accepts
-- (primary subtag plus optional script/region subtags), scoped by `conrelid`
-- (lesson of 0056).

ALTER TABLE agent_identities
  ADD COLUMN IF NOT EXISTS language TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_identities_language_check'
       AND conrelid = 'agent_identities'::regclass
  ) THEN
    ALTER TABLE agent_identities
      ADD CONSTRAINT agent_identities_language_check
      CHECK (language IS NULL OR language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$');
  END IF;
END $$;

-- rollback:
--   ALTER TABLE agent_identities DROP CONSTRAINT IF EXISTS agent_identities_language_check;
--   ALTER TABLE agent_identities DROP COLUMN IF EXISTS language;
