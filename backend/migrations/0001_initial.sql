PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL DEFAULT '',
  avatar INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_email_created ON auth_codes(email, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  rate_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS sync_documents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  head_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  CHECK (length(state_json) <= 1048576)
);

CREATE TABLE IF NOT EXISTS sync_events (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  base_seq INTEGER NOT NULL,
  ops_json TEXT NOT NULL,
  client_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, server_seq),
  UNIQUE(user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_events_user_seq ON sync_events(user_id, server_seq);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  email TEXT,
  kind TEXT NOT NULL DEFAULT 'general',
  body TEXT NOT NULL,
  app_version TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_releases (
  version TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  published_at INTEGER NOT NULL,
  mandatory INTEGER NOT NULL DEFAULT 0
);
