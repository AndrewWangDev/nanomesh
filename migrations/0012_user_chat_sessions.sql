CREATE TABLE IF NOT EXISTS user_chat_sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    trace_id TEXT,
    title TEXT NOT NULL,
    cost TEXT DEFAULT '0',
    duration TEXT DEFAULT '0s',
    nodes_count INTEGER DEFAULT 1,
    cached INTEGER DEFAULT 0,
    pinned INTEGER DEFAULT 0,
    rounds_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_user_updated ON user_chat_sessions(user_id, updated_at DESC);
