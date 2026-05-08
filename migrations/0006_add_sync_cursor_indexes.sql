CREATE INDEX IF NOT EXISTS idx_sync_items_user_updated_cursor
  ON sync_items (user_id, updated_at_ms, op_id, sector_key, item_key);

CREATE INDEX IF NOT EXISTS idx_sync_items_user_sector_updated_cursor
  ON sync_items (user_id, sector_key, updated_at_ms, op_id, item_key);

CREATE INDEX IF NOT EXISTS idx_list_sync_items_user_updated_cursor
  ON list_sync_items (user_id, updated_at_ms, list_key, item_key);
