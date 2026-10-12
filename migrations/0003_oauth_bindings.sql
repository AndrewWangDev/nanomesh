-- Create the new relation table for many-to-one OAuth bindings
CREATE TABLE user_oauth_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- Indexes for fast lookup
CREATE UNIQUE INDEX idx_user_oauth_bindings_user_provider ON user_oauth_bindings(user_id, provider);
CREATE UNIQUE INDEX idx_user_oauth_bindings_provider_id ON user_oauth_bindings(provider, provider_id);

-- Migrate existing data
INSERT INTO user_oauth_bindings (user_id, provider, provider_id)
SELECT user_id, oauth_provider, oauth_id 
FROM users 
WHERE oauth_provider IS NOT NULL AND oauth_id IS NOT NULL;
