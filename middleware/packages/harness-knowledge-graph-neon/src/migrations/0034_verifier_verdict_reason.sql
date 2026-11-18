-- The answer verifier stores the reason a `skipped` or `unavailable` verdict
-- carries, next to its status.
--
-- `status` alone cannot tell what `enforce` does with a `skipped` answer: it
-- delivers one whose reason is `no_trigger` or `no_claims` (nothing in the
-- answer to check) and withholds one whose reason is `no_checkable_claims` or
-- `incomplete_coverage` (claims nobody checked). So the share of answers
-- `enforce` would deliver could not be read from the rows `shadow` writes —
-- the calibration step `docs/upgrading.md` describes before switching modes.
-- An `unavailable` row's reason (`extractor_error`, `pipeline_error`,
-- `privacy_shield`) used to reach the log only.
--
-- NULL for every other status, and for rows written before this migration.
-- Closed codes only (`VerifierSkipReason`, `VerifierUnavailableReason`):
-- `VerifierStore` writes the verdict's reason after the service bound it, never
-- a message.
--
-- Idempotent: IF NOT EXISTS, so a re-run or a partially applied deploy is a
-- no-op.

ALTER TABLE verifier_verdicts
  ADD COLUMN IF NOT EXISTS reason TEXT NULL;
