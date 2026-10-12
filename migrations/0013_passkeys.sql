CREATE TABLE IF NOT EXISTS user_passkeys (
    credential_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    public_key_alg INTEGER NOT NULL DEFAULT -7,
    counter INTEGER NOT NULL DEFAULT 0,
    device_name TEXT NOT NULL,
    aaguid TEXT,
    transports TEXT DEFAULT '["internal"]',
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user ON user_passkeys(user_id);
