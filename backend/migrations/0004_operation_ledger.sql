-- Sync 2.0 phase 3: durable idempotency ledger independent from prunable event history.
CREATE TABLE IF NOT EXISTS operation_ledger (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_operation_ledger_user_seq ON operation_ledger(user_id, server_seq);
