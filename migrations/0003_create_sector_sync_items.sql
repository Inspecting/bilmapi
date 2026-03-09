CREATE TABLE IF NOT EXISTS sync_items (
  user_id TEXT NOT NULL,
  sector_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  item_json TEXT,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  device_id TEXT,
  op_id TEXT,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (user_id, sector_key, item_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_items_user_updated
  ON sync_items (user_id, updated_at_ms);

CREATE INDEX IF NOT EXISTS idx_sync_items_user_sector_updated
  ON sync_items (user_id, sector_key, updated_at_ms);

CREATE TABLE IF NOT EXISTS user_sync_state (
  user_id TEXT PRIMARY KEY,
  migrated_at_ms INTEGER,
  migration_source TEXT,
  updated_at_ms INTEGER NOT NULL,
  saved_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sync_state_updated
  ON user_sync_state (updated_at_ms);
