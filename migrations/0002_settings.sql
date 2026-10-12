-- Add tracking for avatar update cooldown
ALTER TABLE users ADD COLUMN avatar_updated_at TEXT;

-- User uploaded models
CREATE TABLE user_models (
    model_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' (审核中), 'approved' (待发布), 'published' (已发布)
    usage_count INTEGER NOT NULL DEFAULT 0,
    user_rating REAL NOT NULL DEFAULT 0.0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- Billing ledger for transactions
CREATE TABLE billing_ledger (
    transaction_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    type TEXT NOT NULL, -- 'topup' or 'usage'
    description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);
