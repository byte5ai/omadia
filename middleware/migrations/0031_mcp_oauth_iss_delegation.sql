-- ── MCP OAuth: RFC 9207 `iss` binding + explicit delegation mode (W0-1) ─────
-- Three live defects in the MCP OAuth path are closed here:
--
--  D1  The callback trusted `state` alone and never validated the RFC 9207
--      `iss` authorization-response parameter against the issuer recorded for
--      the flow. `mcp_oauth_flows.issuer` already exists; what was missing is
--      knowing whether the authorization server ADVERTISED iss support, so an
--      absent `iss` from an AS that promised one can be rejected. That flag is
--      captured at authorize time (never re-discovered at callback — same
--      reasoning as migration 0016).
--
--  D2  `oauthUserKey()` silently fell back to the shared literal 'operator',
--      so a channel turn (Teams/Telegram) with no mapped identity inherited
--      the operator's authority at the customer's MCP server — a confused
--      deputy. `mcp_servers.delegation` makes the choice explicit per server:
--        per_user → the acting identity must resolve, or the call fails closed
--        service  → one shared identity is the deliberate, opted-in design
--
--  D3  Concurrent refreshes for the same (server, user) raced each other. Not
--      a schema concern, but `mcp_oauth_tokens.issuer` lands here so a stored
--      token can be invalidated when its issuer rotates.
--
-- ⚠️ OPERATOR-VISIBLE BEHAVIOUR CHANGE — read before deploying.
-- A fail-closed `per_user` default for EVERY row would break installed systems
-- whose channel users reach MCP servers today precisely BECAUSE of the
-- 'operator' fallback. So this migration is deliberately asymmetric:
--   • existing rows that already hold an operator token keep today's shared
--     behaviour (delegation = 'service'), and
--   • only NEWLY created servers get the safe 'per_user' default.
-- Operators who want per-user delegation on an existing server must opt in via
-- the MCP Control Center (or UPDATE the column directly).

-- ── D2: explicit delegation mode per MCP server ─────────────────────────────
ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS delegation TEXT NOT NULL DEFAULT 'per_user';

-- `conname` is unique per (connamespace, conrelid), NOT cluster-wide, so an
-- unanchored lookup reports "exists" for a same-named constraint sitting in any
-- other schema and the ALTER below is silently skipped. Anchoring on
-- `conrelid = 'mcp_servers'::regclass` resolves the relation through
-- `search_path`, matching every other unqualified reference in this file. The
-- cast cannot raise here: the ALTER TABLE above already required the table to
-- resolve.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mcp_servers_delegation_chk'
       AND conrelid = 'mcp_servers'::regclass
  ) THEN
    ALTER TABLE mcp_servers
      ADD CONSTRAINT mcp_servers_delegation_chk
      CHECK (delegation IN ('per_user', 'service'));
  END IF;
END $$;

-- Backward compatibility (see the warning above): every EXISTING server that
-- already holds an OPERATOR token keeps the shared identity it is working with
-- today. Guarded by to_regclass so the migration is safe on a database where
-- mcp_oauth_tokens has not been created yet. The argument is UNQUALIFIED on
-- purpose: it must resolve through `search_path` like every other reference in
-- this file. A hardcoded `public.` would probe the wrong schema wherever the
-- domain is applied outside `public` — the guard would then answer about a
-- table this statement does not touch, and the backfill would be skipped (or
-- run) for a reason unrelated to the data in front of it.
--
-- The predicate is `user_key = 'operator'`, NOT "has any token row". This
-- backfill exists solely to preserve the behaviour the 'operator' fallback was
-- producing (see D2 above), and that fallback only ever applied where an
-- operator token existed to borrow. A server holding only per-user tokens —
-- `user_key = 'alice@corp.com'` and nothing else — was never using a shared
-- identity, so flipping it to 'service' would be a silent identity change no
-- operator decided on: `resolveMcpUserKey` would hand every caller the shared
-- `operator` key, and once anyone completed a re-auth the minted operator token
-- would be shared by every caller, including unmapped channel users. The
-- narrow predicate leaves such a server on the safe 'per_user' default, which
-- is the choice its stored tokens already imply.
--
-- The literal must stay in sync with `SERVICE_USER_KEY` in
-- `src/services/mcpDelegation.ts` (a migration cannot import it).
DO $$
BEGIN
  IF to_regclass('mcp_oauth_tokens') IS NOT NULL THEN
    UPDATE mcp_servers s
       SET delegation = 'service'
     WHERE EXISTS (
       SELECT 1 FROM mcp_oauth_tokens t
        WHERE t.server_id = s.id
          AND t.user_key = 'operator'
     );
  END IF;
END $$;

-- ── D1: remember whether the AS advertised RFC 9207 at authorize time ───────
-- NULL on pre-0031 in-flight flows → treated as "not advertised", so a flow
-- started before this migration is not retroactively rejected for a missing
-- `iss`. A mismatched `iss` is rejected regardless of this flag.
ALTER TABLE mcp_oauth_flows
  ADD COLUMN IF NOT EXISTS iss_required BOOLEAN NOT NULL DEFAULT false;

-- ── D3 companion: bind a stored token to the issuer that minted it ──────────
-- Lets a token be invalidated when the server's issuer rotates instead of
-- being replayed against a different authorization server.
ALTER TABLE mcp_oauth_tokens
  ADD COLUMN IF NOT EXISTS issuer TEXT;

-- ── Audit: record the acting identity on every MCP call ─────────────────────
-- `caller_agent` is the orchestrator/sub-agent slug, not WHO the call acted
-- as. Without this an operator cannot answer "whose credentials touched that
-- server?" — the exact question the confused-deputy bug raises.
ALTER TABLE mcp_call_log
  ADD COLUMN IF NOT EXISTS acting_identity TEXT;

-- rollback: ALTER TABLE mcp_call_log DROP COLUMN acting_identity; ALTER TABLE mcp_oauth_tokens DROP COLUMN issuer; ALTER TABLE mcp_oauth_flows DROP COLUMN iss_required; ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_delegation_chk, DROP COLUMN delegation;
