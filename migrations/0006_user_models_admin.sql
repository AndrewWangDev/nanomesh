ALTER TABLE user_uploaded_models ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_uploaded_models ADD COLUMN user_rating REAL NOT NULL DEFAULT 5.0;
ALTER TABLE user_uploaded_models ADD COLUMN live_model_id TEXT;
ALTER TABLE user_uploaded_models ADD COLUMN reviewed_at TEXT;
ALTER TABLE user_uploaded_models ADD COLUMN published_at TEXT;
ALTER TABLE user_uploaded_models ADD COLUMN r2_upload_id TEXT;

CREATE INDEX IF NOT EXISTS idx_uploaded_status ON user_uploaded_models(status, created_at);
