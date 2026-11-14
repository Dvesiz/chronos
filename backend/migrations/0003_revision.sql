-- Sync 2.0 phase 2: separate business revision from event-log head sequence.
ALTER TABLE sync_documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
