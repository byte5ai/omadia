-- 0004_routines_output_template.sql
-- Phase C — Server-Side Templates for Routines.
--
-- Adds an optional `output_template` JSONB column. When non-NULL the
-- orchestrator routes the routine through the template-rendering path:
-- the LLM is asked for narrative slots only, the data sections are
-- rendered server-side from the raw tool result, and the privacy
-- pipeline scrubs only the narrative slots (data never reached the
-- public LLM in identifiable form).
--
-- Backward compatible: every existing row keeps NULL → the legacy
-- LLM-authors-everything path is unchanged. The new behaviour
-- activates only when the routine carries a template, set via the
-- operator UI / API.
--
-- Schema is intentionally a JSONB blob rather than a normalised set
-- of tables: templates are operator-authored, evolve as plugin tool
-- schemas evolve, and live alongside the routine config they apply
-- to. JSONB keeps the migration cost low and the routine row
-- self-contained.
--
-- For the type shape see `RoutineOutputTemplate` in
-- src/plugins/routines/routineOutputTemplate.ts, which validates it and is
-- therefore the contract. (The former citation pointed into
-- docs/harness-platform/, a gitignored local tree that resolves for nobody
-- else.)

ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS output_template JSONB NULL;

COMMENT ON COLUMN routines.output_template IS
  'Phase C — optional output template. NULL = legacy LLM-authors-everything path. Non-NULL = render data sections server-side from raw tool result, LLM produces narrative slots only. Shape: RoutineOutputTemplate (sections: data-table | data-list | narrative-slot | static-markdown).';
