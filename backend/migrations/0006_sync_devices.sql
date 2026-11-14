-- Sync 2.0 phase 6: per-device acknowledgement cursors.
CREATE TABLE IF NOT EXISTS sync_devices (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  acknowledged_seq INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  app_version TEXT,
  protocol_version INTEGER NOT NULL DEFAULT 1,
  revoked_at INTEGER,
  PRIMARY KEY (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_devices_user_seen ON sync_devices(user_id, last_seen_at);
