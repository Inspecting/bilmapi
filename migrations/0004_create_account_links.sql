CREATE TABLE IF NOT EXISTS account_links (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  target_user_id TEXT,
  target_email TEXT NOT NULL,
  requester_share_scopes_json TEXT NOT NULL,
  target_share_scopes_json TEXT NOT NULL,
  requester_approved_at_ms INTEGER,
  target_approved_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  activated_at_ms INTEGER,
  declined_at_ms INTEGER,
  unlinked_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_account_links_requester_user
  ON account_links (requester_user_id, status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_account_links_target_user
  ON account_links (target_user_id, status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_account_links_requester_email
  ON account_links (requester_email, status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_account_links_target_email
  ON account_links (target_email, status, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS account_user_capabilities (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  chat_ready INTEGER NOT NULL DEFAULT 0,
  last_chat_seen_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_user_capabilities_email
  ON account_user_capabilities (email, updated_at_ms DESC);
