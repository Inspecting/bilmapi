CREATE TABLE IF NOT EXISTS list_sync_items (
  user_id TEXT NOT NULL,
  list_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  item_json TEXT,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  device_id TEXT,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (user_id, list_key, item_key)
);

CREATE INDEX IF NOT EXISTS idx_list_sync_items_user_updated
  ON list_sync_items (user_id, updated_at_ms);
