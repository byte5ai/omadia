-- ── Bind the token exchange to the authorize-time endpoints (W9 codex fold) ──
-- The critical fix: the callback must exchange the code against the SAME token
-- endpoint discovered when the flow started, not a freshly re-discovered one —
-- otherwise a server could advertise a legit auth server for the authorize
-- step, then switch its metadata before the callback and steal the code + PKCE
-- verifier + client secret. We persist the endpoints in the flow and use them
-- verbatim at completion (no re-discovery).
ALTER TABLE mcp_oauth_flows
  ADD COLUMN IF NOT EXISTS token_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS authorization_endpoint TEXT;

-- rollback: ALTER TABLE mcp_oauth_flows DROP COLUMN token_endpoint, DROP COLUMN authorization_endpoint;
