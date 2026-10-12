-- Migration: 0008_notifications.sql
-- Notification Center system for NanoMesh: direct user notifications and global broadcast announcements.

CREATE TABLE IF NOT EXISTS notifications (
    notification_id TEXT PRIMARY KEY,
    user_id         TEXT,                         -- NULL for global broadcast, or specific user_id
    category        TEXT NOT NULL,                -- 'model' | 'billing' | 'quota' | 'task' | 'system'
    event_type      TEXT NOT NULL,                -- 'model_approved' | 'model_published' | 'model_rejected' | 'model_delisted' | 'topup_success' | 'low_balance' | 'task_failed' | 'admin_broadcast'
    priority        TEXT NOT NULL DEFAULT 'normal',-- 'normal' | 'urgent'
    
    title_zh        TEXT NOT NULL,
    title_en        TEXT NOT NULL,
    content_zh      TEXT NOT NULL,
    content_en      TEXT NOT NULL,
    
    action_type     TEXT DEFAULT 'none',          -- 'route' | 'url' | 'none'
    action_payload  TEXT,                         -- JSON string e.g. '{"modal":"settings","tab":"models"}'
    
    related_id      TEXT,                         -- upload_id, code_id, ledger_id, etc.
    extra_data      TEXT,                         -- Optional JSON string for extra metadata
    
    is_read         INTEGER DEFAULT 0,            -- 0: unread, 1: read (for direct user notifications)
    read_at         TEXT,
    
    created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notif_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_category ON notifications(user_id, category);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id, is_read);

-- Tracks read receipts for global broadcasts (user_id IS NULL)
CREATE TABLE IF NOT EXISTS broadcast_reads (
    user_id         TEXT NOT NULL,
    notification_id TEXT NOT NULL,
    read_at         TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, notification_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (notification_id) REFERENCES notifications(notification_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_broadcast_reads_user ON broadcast_reads(user_id);
