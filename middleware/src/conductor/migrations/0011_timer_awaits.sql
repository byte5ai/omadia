-- #330 C3 — timer awaits: the deterministic tick behind bounded assess/nudge
-- loops. A timer step parks the run via the existing await machinery
-- (deadline poll → expireAwait → on-expiry fallback); the only schema change
-- is widening the principal-kind CHECK. Idempotent per the 0008/0009 pattern.

ALTER TABLE conductor_awaits DROP CONSTRAINT IF EXISTS conductor_awaits_principal_kind_check;
ALTER TABLE conductor_awaits ADD CONSTRAINT conductor_awaits_principal_kind_check
  CHECK (principal_kind IN ('user', 'role', 'timer'));
