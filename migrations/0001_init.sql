CREATE TABLE users (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,  -- NULL for OAuth-only users
    oauth_provider TEXT, -- 'github' | 'google' | NULL
    oauth_id TEXT,       -- provider's user ID
    avatar_url TEXT,
    credits REAL NOT NULL DEFAULT 10000,
    frozen_credits REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_oauth ON users(oauth_provider, oauth_id) WHERE oauth_provider IS NOT NULL;

CREATE TABLE models (
    model_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    modalities TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    context_window INTEGER NOT NULL DEFAULT 4096,
    max_concurrency INTEGER NOT NULL DEFAULT 10,
    active_connections INTEGER NOT NULL DEFAULT 0,
    precision REAL NOT NULL DEFAULT 0.8,
    user_rating REAL NOT NULL DEFAULT 5.0,
    usage_count INTEGER NOT NULL DEFAULT 0,
    cost_per_1k_tokens REAL NOT NULL DEFAULT 1.0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_vc_email ON verification_codes(email, expires_at);

CREATE TABLE frozen_tickets (
    ticket_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    frozen_amount REAL NOT NULL,
    model_ids TEXT NOT NULL DEFAULT '[]',
    dag_json TEXT,
    status TEXT NOT NULL DEFAULT 'frozen',
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    settled_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);
CREATE INDEX idx_frozen_status ON frozen_tickets(status, expires_at);

CREATE TABLE settlements (
    settlement_id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    frozen_amount REAL NOT NULL,
    actual_amount REAL NOT NULL,
    refund_amount REAL NOT NULL,
    node_details TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE system_counters (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);
INSERT INTO system_counters (key, value) VALUES ('emails_sent', 0);

-- Seed demo models
INSERT INTO models (model_id, display_name, provider, endpoint, modalities, tags, context_window, max_concurrency, precision, user_rating, cost_per_1k_tokens) VALUES
('model-whisper-01', 'Whisper ASR', 'worker-ai', '/api/infer', '["audio"]', '["#asr","#audio_processing"]', 0, 5, 0.95, 5.0, 2.0),
('model-qwen3-01', 'Qwen3 翻译', 'worker-ai', '/api/infer', '["text"]', '["#translation","#multilingual","#text_generation"]', 32768, 10, 0.90, 5.0, 1.5),
('model-llama3-01', 'Llama-3 写作', 'worker-ai', '/api/infer', '["text"]', '["#text_generation","#creative_writing","#chat"]', 8192, 8, 0.80, 5.0, 1.0);
