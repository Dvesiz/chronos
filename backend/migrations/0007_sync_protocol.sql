-- Sync 2.0 protocol metadata and forward-compatible document schema.
ALTER TABLE sync_documents ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 3;

CREATE TABLE IF NOT EXISTS sync_snapshots (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  head_seq INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_sync_snapshots_user_created ON sync_snapshots(user_id, created_at DESC);
