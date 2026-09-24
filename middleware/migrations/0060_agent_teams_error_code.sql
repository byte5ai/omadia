-- ── Agent factory: persist the Teams provisioning failure STRUCTURED ───────
-- Adds `error_code` + `error_detail` to `agent_teams_identities`
-- (byte5ai/omadia#897, follow-up of #860 wave W2a).
--
-- WHY
-- ---
-- Until now the provisioning runner wrote a failure ONLY as an English
-- sentence into `last_error`, and the operator route rebuilt the machine-
-- readable form (`last_error_detail`: code + scopes / fields / Retry-After /
-- consent URL / reason) by parsing that sentence back — prefixes, the first
-- `[...]` group, a `; retry after Ns` fragment. Load-bearing syntax inside a
-- string whose stated purpose is to be read by a human.
--
-- The runner holds the typed error at the moment it writes, so it now writes
-- both: the sentence (still `last_error`, free to be reworded) and the code
-- plus its typed arguments (these two columns). The route reads the columns;
-- the sentence classifier stays only as the fallback for rows written before
-- this migration.
--
-- NO BACKFILL
-- -----------
-- SQL cannot run the TypeScript classifier, and a second copy of it in SQL
-- would be exactly the drift this migration removes. Legacy rows keep
-- `error_code IS NULL` and are classified at READ time from `last_error`,
-- which is what already happens today — so nothing changes for them.
--
-- NO CHECK CONSTRAINT ON `error_code`, ON PURPOSE
-- ------------------------------------------------
-- 0049 (`state`) and 0054 (`target_kind`) use CHECKs, but those vocabularies
-- are stable and drive control flow. This one has grown from 4 to 12 codes in
-- a few weeks, and every addition would need a DROP/ADD CHECK migration (0056
-- exists only to repair CHECK idempotency). More importantly, the runner
-- writes `state` and the error in ONE best-effort UPDATE that swallows store
-- errors: a code missing from a CHECK would fail that UPDATE and silently
-- lose the terminal `state = 'failed'` write — the #915 class of bug. The
-- closed TypeScript union `TeamsProvisioningErrorCode`
-- (`services/teamsProvisioningJob.ts`) is the single vocabulary, and the read
-- path validates the stored value against it (an unknown code falls back to
-- the classifier).
--
-- INVARIANT (enforced by `AgentTeamsIdentityStore.update`, not by SQL): any
-- write of `last_error` also writes both columns — the provided values or
-- NULL — so a new sentence can never pair with a stale code.
--
-- Idempotent by construction (ADD COLUMN IF NOT EXISTS), because schema CI
-- double-applies every file in this series.

ALTER TABLE agent_teams_identities
  ADD COLUMN IF NOT EXISTS error_code TEXT NULL;

ALTER TABLE agent_teams_identities
  ADD COLUMN IF NOT EXISTS error_detail JSONB NULL;

-- rollback: ALTER TABLE agent_teams_identities DROP COLUMN error_detail;
-- rollback: ALTER TABLE agent_teams_identities DROP COLUMN error_code;
