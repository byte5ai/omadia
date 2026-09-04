-- #1033 W2 — per-agent model policy + persona prompts per model family.
--
-- 1. `agents.model_policy` — the operator's default LLM for an agent plus a
--    fallback for when it is unavailable:
--
--        { "primary":  "auto" | { provider, model, effort? },
--          "fallback": "none" | "auto" | { provider, model, effort? } }
--
--    `"auto"` is exactly today's resolution (`model_routing.main` → platform
--    default → built-in default, plus triage when configured); `"none"` is
--    today's failure behaviour (the turn dies once retries are spent). So the
--    DEFAULT `{primary: auto, fallback: none}` is byte-identical behaviour for
--    every existing agent — the no-flag-day guarantee.
--
--    Backfill from `model_routing`: a `mode: 'single'` routing whose `main`
--    is a PROVIDER-QUALIFIED ref (`anthropic:claude-opus-4-8`) becomes an
--    explicit primary. A bare id (`claude-opus-4-8`) stays `auto`: SQL cannot
--    know which provider it belongs to, and `auto` still honours it through
--    `model_routing` at runtime — so nothing changes for it either. Triage
--    stays under `auto` by design (it IS the auto/triage config). The
--    backfill runs only when the column is created, never on re-apply.
--
-- 2. `agent_identities.composed_prompts` — the compiled persona prompt PER
--    MODEL FAMILY (`{ "opus": "...", "sonnet": "..." }`). The single
--    `composed_prompt`/`composed_family` pair (0053) assumes one family per
--    agent; a policy whose fallback runs on another family would otherwise
--    serve a prompt composed for the wrong one — silently, with no test
--    failing. The identity routes now compile for every family the policy
--    names and store the map here; `composed_prompt` keeps the primary
--    family's text so every existing reader is unchanged.
--
-- Both idempotent (ADD COLUMN IF NOT EXISTS; the backfill is inside the
-- column-creation branch), and the CHECK probe is `conrelid`-scoped (#952).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'agents'
       AND column_name = 'model_policy'
  ) THEN
    ALTER TABLE agents
      ADD COLUMN model_policy JSONB NOT NULL
        DEFAULT '{"primary":"auto","fallback":"none"}'::jsonb;

    -- Backfill: qualified single refs become an explicit primary (see header).
    UPDATE agents
       SET model_policy = jsonb_build_object(
             'primary', jsonb_build_object(
               'provider', split_part(model_routing->>'main', ':', 1),
               'model',    substr(model_routing->>'main', position(':' in model_routing->>'main') + 1)
             ),
             'fallback', 'none'
           )
     WHERE model_routing IS NOT NULL
       AND model_routing->>'mode' = 'single'
       AND position(':' in coalesce(model_routing->>'main', '')) > 1;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agents_model_policy_shape_check'
       AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_model_policy_shape_check
      CHECK (
        jsonb_typeof(model_policy) = 'object'
        AND model_policy ? 'primary'
        AND model_policy ? 'fallback'
      );
  END IF;
END
$$;

COMMENT ON COLUMN agents.model_policy IS
  '#1033 per-agent LLM policy: {primary: auto | {provider, model, effort?}, fallback: none | auto | {provider, model, effort?}}. auto = model_routing/platform default; none = fail the turn.';

ALTER TABLE agent_identities
  ADD COLUMN IF NOT EXISTS composed_prompts JSONB;

COMMENT ON COLUMN agent_identities.composed_prompts IS
  'CACHE: compiled identity prompt per model family ({"opus": "...", "sonnet": "..."}) for every family the agent''s model policy names. composed_prompt stays the primary family''s text.';

-- rollback:
--   ALTER TABLE agent_identities DROP COLUMN composed_prompts;
--   ALTER TABLE agents DROP CONSTRAINT agents_model_policy_shape_check;
--   ALTER TABLE agents DROP COLUMN model_policy;
