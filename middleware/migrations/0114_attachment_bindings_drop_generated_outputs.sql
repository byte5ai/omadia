-- ── #1960 (ADR-0178): drop bindings that a READ created for generated output ──
-- Until #1960 the first chat to read an unbound storage key bound the key to
-- itself (bind-on-first-read). Office reports and diagrams are never read when
-- they are created, so any chat that learned such a key (from a download link)
-- could claim it and read it through `read_attachment` from then on.
--
-- Bindings are now written only when a channel adapter states an upload, and
-- generated outputs are never bound. Rows for the two generated layouts can
-- only have come from a foreign first read; they are removed so those claims
-- end with the deploy:
--   - Office:   documents/<tenant>/<sha256>/<filename>
--   - Diagrams: <tenant>/<sha256>.png
-- Uploads (`teams-attachments/…` and other adapter prefixes) keep their rows.
DELETE FROM attachment_scope_bindings
 WHERE storage_key ~ '^documents/[^/]+/[0-9a-f]{64}/[^/]+$'
    OR storage_key ~ '^[^/]+/[0-9a-f]{64}\.png$';
