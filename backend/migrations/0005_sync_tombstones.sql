-- Sync 2.0 phase 4: durable deletion tombstones.
CREATE TABLE IF NOT EXISTS sync_tombstones (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  delete_revision INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_tombstones_user_revision ON sync_tombstones(user_id, delete_revision);
