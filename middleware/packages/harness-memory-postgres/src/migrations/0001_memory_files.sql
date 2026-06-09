CREATE TABLE IF NOT EXISTS memory_files (
  virtual_path TEXT PRIMARY KEY,
  content      TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_files_prefix ON memory_files (virtual_path text_pattern_ops);
