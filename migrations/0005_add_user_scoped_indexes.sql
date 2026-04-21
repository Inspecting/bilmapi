CREATE INDEX IF NOT EXISTS idx_list_sync_items_user_list_updated
  ON list_sync_items (user_id, list_key, updated_at_ms);

CREATE INDEX IF NOT EXISTS idx_list_sync_items_user_deleted_at
  ON list_sync_items (user_id, deleted_at_ms);

CREATE INDEX IF NOT EXISTS idx_sync_items_user_deleted_at
  ON sync_items (user_id, deleted_at_ms);

CREATE INDEX IF NOT EXISTS idx_account_links_status_requester_user
  ON account_links (status, requester_user_id, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_account_links_status_target_user
  ON account_links (status, target_user_id, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_account_links_status_requester_email
  ON account_links (status, requester_email, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_account_links_status_target_email
  ON account_links (status, target_email, updated_at_ms DESC);
