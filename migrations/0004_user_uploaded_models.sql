-- Migration: 0004_user_uploaded_models.sql
-- Creates the isolated staging table for user-submitted model metadata.
-- This table is completely separate from the live `models` table.

CREATE TABLE IF NOT EXISTS user_uploaded_models (
    upload_id       TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,

    -- Basic info
    display_name    TEXT NOT NULL,
    description     TEXT NOT NULL,

    -- Scheduling metadata (all stored as canonical English keys)
    param_scale     TEXT NOT NULL,
    in_modalities   TEXT NOT NULL DEFAULT '["text"]',
    out_modality    TEXT NOT NULL DEFAULT 'text',
    capability_tags TEXT NOT NULL DEFAULT '[]',
    context_window  INTEGER NOT NULL DEFAULT 4096,

    -- Physical file storage
    file_name       TEXT NOT NULL,
    file_size       INTEGER NOT NULL,
    r2_object_key   TEXT NOT NULL,

    -- Review workflow
    status          TEXT NOT NULL DEFAULT 'pending',
    admin_feedback  TEXT,

    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),

    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_uploaded_user ON user_uploaded_models(user_id, status);
