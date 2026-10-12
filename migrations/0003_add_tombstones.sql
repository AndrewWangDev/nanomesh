CREATE TABLE account_tombstones (
    hash_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX idx_tombstones_expires ON account_tombstones(expires_at);
