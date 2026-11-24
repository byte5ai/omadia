-- #2049 (epic #2042, spec 2042 section 5.10) — an agent can be a `draft`.
--
-- Previews in the Agent Builder and the Plugin Builder are turns of a draft
-- agent: a real `agents` row with its own envelope, marked "preview", that is
-- never addressable in a channel. The registry builds only `enabled` agents
-- (applyDiff), and routing treats every status except `enabled` as not
-- addressable, so a draft has no runtime presence until an operator enables
-- it.
--
-- Expand-only: an image from before this migration never writes `draft` and
-- reads the rows it knows unchanged.

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_status_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_status_check CHECK (status IN ('enabled', 'disabled', 'draft'));

-- Rollback (only while no row is a draft):
--   ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_status_check;
--   ALTER TABLE agents ADD CONSTRAINT agents_status_check CHECK (status IN ('enabled', 'disabled'));
