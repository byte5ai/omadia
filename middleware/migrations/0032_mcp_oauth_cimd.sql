-- ── W2-4: Client ID Metadata Documents as a THIRD client-acquisition mode ───
-- (issue #546, CIMD half)
--
-- Context that the issue body gets wrong: omadia does NOT "only support static
-- headers with secretRef". A complete provider-agnostic OAuth 2.1 + PKCE stack
-- shipped in epic #459 W9 (migration 0015, services/mcpOAuth*.ts). This
-- migration is a delta on that stack, not a new subsystem.
--
-- CIMD lets the client identify itself by an https URL that the authorization
-- server FETCHES, instead of pre-registering a client_id. It replaces Dynamic
-- Client Registration against MCP-native brokers (Smithery-class) — and ONLY
-- those. It is not the enterprise path:
--
--   • Entra ID and Okta do not support CIMD. They use pre-registered app
--     registrations, for which the correct path is the EXISTING manual client
--     (`setManualClient`, registered_via = 'manual').
--   • CIMD additionally requires the IdP to make an INBOUND https request to
--     omadia. That is strictly stronger than the outbound-redirect-only
--     requirement the manual path has, and impossible behind a corporate
--     firewall or on an air-gapped install.
--
-- Decision recorded here so a later reader does not "clean up" the manual path:
-- 'cimd' and 'manual' COEXIST PERMANENTLY. There is no sunset for 'manual', and
-- 'dcr' is deprecated by the MCP spec on a 12-month clock but still works.
--
-- Single tenancy: no table in any migration carries a tenant column. One
-- omadia install serves one organization, so `mcp_oauth_clients` is keyed by
-- issuer alone and a CIMD client_id identifies THIS install globally.

-- ── Widen registered_via to admit the third mode ─────────────────────────────
-- 0015 created the constraint inline, so Postgres named it
-- `mcp_oauth_clients_registered_via_check`. Drop whichever name is present and
-- re-add an explicitly named one so a future migration has a stable handle.
ALTER TABLE mcp_oauth_clients
  DROP CONSTRAINT IF EXISTS mcp_oauth_clients_registered_via_check;
ALTER TABLE mcp_oauth_clients
  DROP CONSTRAINT IF EXISTS mcp_oauth_clients_registered_via_chk;
ALTER TABLE mcp_oauth_clients
  ADD CONSTRAINT mcp_oauth_clients_registered_via_chk
  CHECK (registered_via IN ('dcr', 'manual', 'cimd'));

-- ── The metadata document this client_id resolves to ────────────────────────
-- For registered_via = 'cimd' this is the self-referential https URL that IS
-- the client_id (RFC-style CIMD: the client_id is the document's own URL, and
-- the AS dereferences it to read redirect_uris / client_name). Recorded
-- separately from client_id so an operator can see at a glance which document
-- a stored client was acquired from, and so a base-URL change is detectable.
-- NULL for 'dcr' and 'manual' rows.
ALTER TABLE mcp_oauth_clients
  ADD COLUMN IF NOT EXISTS client_metadata_url TEXT;

-- rollback: ALTER TABLE mcp_oauth_clients DROP COLUMN client_metadata_url, DROP CONSTRAINT mcp_oauth_clients_registered_via_chk, ADD CONSTRAINT mcp_oauth_clients_registered_via_check CHECK (registered_via IN ('dcr', 'manual'));
