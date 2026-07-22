CREATE TABLE IF NOT EXISTS watch_parties (
  code TEXT PRIMARY KEY,
  party_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
