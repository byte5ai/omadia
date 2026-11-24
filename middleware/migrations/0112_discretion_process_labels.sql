-- Spec 2042 §5.11 / #2194 — a stored process keeps the labels of the turns
-- that wrote it, like a memorable: `write_process` / `edit_process` persist
-- the writing turn's label set under the subject kind `process` (an edit adds
-- to what earlier writes kept), and a recall of the process brings them into
-- the recalling turn. Recalled plans need no subject of their own: a plan
-- carries the id of the turn that wrote it, whose labels are already kept.
--
-- Widens the subject-kind check of 0098. Idempotent: the schema CI gate
-- applies every file twice.

ALTER TABLE discretion_labels DROP CONSTRAINT IF EXISTS discretion_labels_shape_check;
ALTER TABLE discretion_labels
  ADD CONSTRAINT discretion_labels_shape_check
  CHECK (
    subject_kind IN ('turn', 'memorable', 'memory_file', 'process')
    AND jsonb_typeof(labels) = 'array'
  );
