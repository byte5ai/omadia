-- 0002_routines_timeout_default.sql
-- Bump the per-run timeout default from 60s to 600s (10 minutes). The
-- original 60s default was too tight for routines whose prompt triggers
-- a tool-heavy agent loop (KG lookups, sub-agent delegation, diagram
-- rendering); production runs were timing out before delivery. Existing
-- rows keep their explicitly stored timeout; only NEW inserts that omit
-- `timeout_ms` get the new default.
--
-- Idempotent — `ALTER COLUMN SET DEFAULT` overwrites whatever the column
-- currently has.

ALTER TABLE routines
  ALTER COLUMN timeout_ms SET DEFAULT 600000;
