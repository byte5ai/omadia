-- ── Credential keychain-asks: request → owner-approval → grant (#578 phase 3) ─
-- Deliberately its own table, not `conductor_awaits` — see the header of
-- `middleware/src/credentials/asks.ts` for why: `conductor_awaits` is FK'd
-- NOT NULL to a workflow run and step, and a keychain ask is neither. The
-- PATTERN is mirrored (principal as a kind/ref pair, TTL compared against a
-- caller-supplied instant, atomic claim-then-act); the schema is new.
--
-- `owner` is captured on the ask at creation time rather than re-read from
-- `credentials.owner_ref` at approval time: if a credential's ownership were
-- ever reassigned, an outstanding ask should still be answered by whoever it
-- was actually sent to, not silently redirected.
--
-- 0038 reserved (#746); 0039 turn_receipts (#757); 0040 credentials
-- (#578 phase 1); this series continues at 0041.

CREATE TABLE IF NOT EXISTS credential_asks (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id               UUID NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  requester_kind              TEXT NOT NULL,
  requester_ref               TEXT NOT NULL,
  owner_kind                  TEXT NOT NULL,
  owner_ref                   TEXT NOT NULL,
  purpose                     TEXT NOT NULL CHECK (length(trim(purpose)) > 0),
  mode                        TEXT NOT NULL CHECK (mode IN ('once', 'standing')),
  requested_grant_expires_at  TIMESTAMPTZ,
  ask_expires_at               TIMESTAMPTZ NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at                 TIMESTAMPTZ,
  resolved_by                 TEXT,
  -- Set once `approve` succeeds. No FK ON DELETE action needed beyond the
  -- default (RESTRICT) — a grant a resolved ask points to must not vanish
  -- out from under the audit trail.
  grant_id                    UUID REFERENCES credential_grants(id),
  CONSTRAINT credential_asks_once_has_expiry CHECK (mode = 'standing' OR requested_grant_expires_at IS NOT NULL)
);

-- Owner inbox: "what is pending for me right now" — the hot path for
-- `listPendingForOwner` and for the approve/deny atomic claim's WHERE clause.
CREATE INDEX IF NOT EXISTS credential_asks_owner_pending
  ON credential_asks (owner_kind, owner_ref, status);

-- Requester's own view of asks they made.
CREATE INDEX IF NOT EXISTS credential_asks_requester
  ON credential_asks (requester_kind, requester_ref, created_at DESC);

-- rollback: DROP TABLE credential_asks;
