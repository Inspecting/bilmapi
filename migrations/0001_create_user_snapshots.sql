CREATE TABLE IF NOT EXISTS user_snapshots (
  user_id TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  device_id TEXT,
  schema TEXT,
  saved_at TEXT NOT NULL
);
