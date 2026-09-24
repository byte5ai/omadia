-- ── Agent factory: the install target is a TEAM *or* a CHAT ────────────────
-- Adds `target_kind` to the two tables that address a Teams install target.
--
-- THE FIELD TEST THIS COMES FROM
-- ------------------------------
-- An operator pasted `abc8af8ec7fc471785d3b83c4d84b667` into a field labelled
-- "Team-ID". Provisioning answered `400 teamId needs to be a valid GUID`;
-- once migration 0051's companion fix hyphenated it, Graph answered `404 No
-- team found with Group Id`. All 30 teams of the tenant and their channels
-- were searched afterwards — the id was NEITHER. It was, with high
-- probability, the stem of a GROUP CHAT id.
--
-- The operator had wanted the right thing all along. The schema simply had no
-- word for it: `team_id` was the only target the stack could name, so a group
-- chat could not be requested, could not be validated, and could only fail at
-- the last step of an otherwise complete chain.
--
-- WHY A DISCRIMINATOR COLUMN AND NOT A RENAME
-- -------------------------------------------
-- `team_id` could have become `target_id`. It was not, for three reasons that
-- all point the same way:
--
--   * there are PRODUCTION ROWS. A rename touches the primary key of
--     `agent_teams_installs` (`(agent_id, team_id)`), the foreign key into
--     `agent_teams_identities`, and ~100 call sites in the operator router
--     alone. The blast radius is the whole feature, and the payoff is a
--     better column name.
--   * the DEFAULT backfills correctly and provably. Every row that exists
--     today was written by a code path that could only install into a team,
--     so `DEFAULT 'team'` is not an assumption about old data — it is the
--     only thing old data could have meant.
--   * a rename would still need this column. "Which Graph endpoint installed
--     this?" is not derivable from the id in every case: a bare 32-hex target
--     is ambiguous between a team group id and a chat stem (that is the whole
--     bug above). Storing the kind records what omadia DID, which is the same
--     philosophy `agent_teams_installs` was built on — "the list is what
--     omadia did, not what Graph currently holds".
--
-- So `team_id` keeps its name and gains a companion that says how to read it.
-- The name is now narrower than the contents, which is a real cost; it is
-- paid deliberately, and `platform/teamsInstallTarget.ts` is where the wider
-- vocabulary lives.
--
-- WHY BOTH TABLES
-- ---------------
-- `agent_teams_installs.target_kind` makes the READ MODEL honest: the operator
-- UI can say "Gruppenchat" instead of showing a chat id under a heading that
-- says team.
-- `agent_teams_identities.target_kind` makes RESUME honest: the identity row
-- carries the target of the run in flight, and a run that resumes must call
-- the same Graph endpoint the request asked for rather than re-deriving it
-- from a string whose ambiguity is what started all this.
--
-- Idempotent by construction (ADD COLUMN IF NOT EXISTS, and the constraints
-- are added only when absent), because schema CI double-applies every file.

ALTER TABLE agent_teams_identities
  ADD COLUMN IF NOT EXISTS target_kind TEXT NOT NULL DEFAULT 'team';

ALTER TABLE agent_teams_installs
  ADD COLUMN IF NOT EXISTS target_kind TEXT NOT NULL DEFAULT 'team';

-- The closed vocabulary of `platform/teamsInstallTarget.ts`. A channel is
-- deliberately NOT in it: `19:…@thread.tacv2` is refused at the route because
-- installing into a channel's parent team would put the app in every channel
-- of that team — a wider blast radius than the operator asked for, produced
-- by a guess.
-- The existence probes below are scoped with `conrelid = <table>::regclass`,
-- NOT with `conname` alone. Constraint names are unique per TABLE, not per
-- database: a bare `conname` match finds the constraint in some other schema
-- (every parallel pg test suite runs in its own) and skips adding it here,
-- leaving a column with no CHECK behind and the migration reporting success.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_teams_identities_target_kind_check'
       AND conrelid = 'agent_teams_identities'::regclass
  ) THEN
    ALTER TABLE agent_teams_identities
      ADD CONSTRAINT agent_teams_identities_target_kind_check
      CHECK (target_kind IN ('team', 'group-chat', 'one-on-one-chat'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_teams_installs_target_kind_check'
       AND conrelid = 'agent_teams_installs'::regclass
  ) THEN
    ALTER TABLE agent_teams_installs
      ADD CONSTRAINT agent_teams_installs_target_kind_check
      CHECK (target_kind IN ('team', 'group-chat', 'one-on-one-chat'));
  END IF;
END
$$;

-- rollback: ALTER TABLE agent_teams_installs DROP COLUMN target_kind;
-- rollback: ALTER TABLE agent_teams_identities DROP COLUMN target_kind;
