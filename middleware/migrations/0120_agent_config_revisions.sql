-- ── #2315 (ADR-0277): revisions of the replace-style agent config writes ─────
-- ADR-0216 gave `PUT …/identity` an `expected_revision` and a 409 on a stale
-- write. The other replace-style agent config writes (plugins, bindings,
-- model policy, context memory, fast lane, agent-to-agent, availability) had
-- no revision. One counter per resource, kept on the agent row:
-- `{ "plugins": 3, "model_policy": 1, … }`; a missing key is revision 0.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS config_revisions jsonb NOT NULL DEFAULT '{}'::jsonb;
