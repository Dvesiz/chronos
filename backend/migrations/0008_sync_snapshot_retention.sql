-- Keep a bounded recovery history for restore/diagnostics without making the
-- event log the source of truth.
CREATE INDEX IF NOT EXISTS idx_sync_snapshots_user_revision ON sync_snapshots(user_id, revision DESC);
