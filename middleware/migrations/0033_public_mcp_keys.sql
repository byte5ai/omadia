-- ── W2-3: the public stateless MCP endpoint's per-key authorization ─────────
-- (issue #542)
--
-- Correcting the issue body before anything else, because the schema below is
-- shaped by the correction: #542 claims "the delta is transport exposure +
-- auth, not new tool plumbing". That is false. `ToolDispatchService` (the
-- dispatcher the loopback MCP server already uses) carries an explicit SEAM
-- comment recording that kernel-tool branches, scoped-memory shadowing,
-- privacy interning and trace capture are deliberately NOT replicated versus
-- `Orchestrator.dispatchToolInner`, and dispatch carries no tenant, user or
-- principal at all. Closing that seam is a SIBLING unit; this migration
-- provides the authorization data the endpoint needs either way.
--
-- Two things live here:
--   1. `public_mcp_key_bindings` — the per-key allowlist and agent binding.
--   2. a widened `mcp_call_log.caller_kind`, so a public MCP call is auditable
--      as what it actually is rather than mislabelled as one of the five
--      in-process caller kinds.

-- ── 1. Per-key tool allowlist + agent binding ───────────────────────────────
-- WHY A TABLE RATHER THAN MORE SCOPES ON THE KEY RECORD
--
-- Scopes (`@omadia/api-key-auth`) answer "what class of thing may this key
-- do": list, invoke, write-this-tool. They are vault-resident, per key, and
-- deliberately free-form so plugins can mint their own. What they cannot
-- answer is "WHICH tools, on WHICH agent" — a set that an operator edits, that
-- wants to be inspectable in a query, and that must default to nothing.
--
-- Both halves are required for a call to succeed, and they are checked
-- independently:
--   - the SCOPE says the key holds the capability;
--   - this ROW says the key reaches that specific tool on that specific agent.
-- Neither is sufficient. A key whose scopes say `mcp:write:create_lead` but
-- whose row does not list `create_lead` reaches nothing, and vice versa. That
-- redundancy is deliberate: the two live in different stores (vault vs. DB)
-- with different write paths, so a mistake in one is not a mistake in both.
--
-- ALLOWLIST, NEVER DENYLIST. A key with no row here reaches ZERO tools — it
-- authenticates and is authorized for nothing. That is what makes
-- integration-backed and write-capable tools (Odoo, M365, Confluence) excluded
-- by DEFAULT: they are excluded because nothing is included until an operator
-- names it. A denylist would have made every future tool reachable the moment
-- it was registered, which is a privilege escalation delivered by a deploy.
--
-- KEY → EXACTLY ONE AGENT. `agent_id` is scalar, not an array, and is the
-- primary-key-adjacent fact of this table. omadia had no seam for "which
-- agent's tools does this caller see" — the native tool registry is a process
-- -wide singleton with unique names, and per-agent scoping existed only for
-- DomainTools. This column IS that seam. A key bound to agent A cannot reach
-- agent B's tools even when both agents' tools sit in the same registry,
-- because the endpoint resolves the dispatcher from THIS column and filters to
-- THIS row's allowlist.
CREATE TABLE IF NOT EXISTS public_mcp_key_bindings (
  -- `ApiKeyRecord.id` from `@omadia/api-key-auth`. Not a foreign key: those
  -- records live in the secret vault, not in Postgres, so the database cannot
  -- enforce the reference. The endpoint verifies the key FIRST (constant-time
  -- hash compare against the vault) and only then reads this row, so an
  -- orphaned row grants nothing — it is unreachable without a live key whose
  -- id matches.
  key_id        TEXT PRIMARY KEY,

  -- The ONE agent (orchestrator slug) whose tools this key reaches.
  agent_id      TEXT NOT NULL CHECK (length(agent_id) > 0),

  -- Exact tool names, no patterns. A pattern would reintroduce the "I thought
  -- `odoo_*` didn't cover `odoo_delete_invoice`" mistake that per-tool scopes
  -- exist to prevent, and would silently widen on every newly-registered tool.
  read_tools    TEXT[] NOT NULL DEFAULT '{}',

  -- Write-capable subset, named separately rather than inferred. omadia has no
  -- per-tool "is this a write" metadata today: `DispatchableToolSpec` carries
  -- name/description/input_schema and nothing about effects. Inferring from the
  -- name ("does it start with create_/update_/delete_") would be a guess that
  -- fails open on the first tool named `submit_expense`. So the operator
  -- declares it, and a tool listed here additionally requires the key to hold
  -- `mcp:write:<tool>` AND spends the tighter write rate-limit budget.
  write_tools   TEXT[] NOT NULL DEFAULT '{}',

  -- Separate, tighter budget than the key's general `rateLimitPerMinute`.
  -- Reads are cheap and idempotent; a write is neither. Sharing one budget
  -- would let a read-heavy integration's unused headroom fund a write burst.
  write_rate_limit_per_minute INTEGER NOT NULL DEFAULT 5
                              CHECK (write_rate_limit_per_minute BETWEEN 0 AND 600),

  -- 0 disables the binding without deleting it (and without revoking the key,
  -- which may still be used for chat). Distinct from "no row": an operator can
  -- see that this key WAS configured and is currently parked.
  enabled       BOOLEAN NOT NULL DEFAULT true,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Answers "which keys can reach this agent" without a sequential scan once an
-- install has more than a handful of integrations.
CREATE INDEX IF NOT EXISTS public_mcp_key_bindings_agent_idx
  ON public_mcp_key_bindings (agent_id);

-- ── 2. Audit a public MCP call as what it is ────────────────────────────────
-- 0009 constrained `caller_kind` to the five IN-PROCESS caller kinds (agent,
-- subagent, skill, plugin, unattributed). A public MCP call is none of them:
-- there is no orchestrator turn, no sub-agent, no plugin — there is an API key
-- held by a third party. Squeezing it into `plugin` or `unattributed` would
-- make the one question this row exists to answer ("was this an internal turn
-- or the internet?") unanswerable from the data.
--
-- `acting_identity` (added by 0031 for the confused-deputy fix) carries the
-- key: `apikey:<keyId>`, or the literal `unresolved` when the identity could
-- not be established — the SAME vocabulary 0031 established, reused rather than
-- reinvented, so one operator query covers both sources.
--
-- 0009 created the constraint inline, so Postgres named it
-- `mcp_call_log_caller_kind_check`. Drop whichever name is present and re-add
-- an explicitly named one, so a future migration has a stable handle.
ALTER TABLE mcp_call_log
  DROP CONSTRAINT IF EXISTS mcp_call_log_caller_kind_check;
ALTER TABLE mcp_call_log
  DROP CONSTRAINT IF EXISTS mcp_call_log_caller_kind_chk;
ALTER TABLE mcp_call_log
  ADD CONSTRAINT mcp_call_log_caller_kind_chk
  CHECK (caller_kind IN ('agent', 'subagent', 'skill', 'plugin', 'unattributed', 'api_key'));

-- rollback: DELETE FROM mcp_call_log WHERE caller_kind = 'api_key'; ALTER TABLE mcp_call_log DROP CONSTRAINT mcp_call_log_caller_kind_chk, ADD CONSTRAINT mcp_call_log_caller_kind_check CHECK (caller_kind IN ('agent', 'subagent', 'skill', 'plugin', 'unattributed')); DROP TABLE public_mcp_key_bindings;
