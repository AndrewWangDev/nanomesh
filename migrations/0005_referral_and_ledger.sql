-- Migration: 0005_referral_and_ledger.sql
-- Adds referral code system and credit ledger for real billing data.

-- 1. Add referral columns to users
ALTER TABLE users ADD COLUMN referral_code TEXT UNIQUE;
ALTER TABLE users ADD COLUMN referred_by TEXT;

-- 2. Backfill existing users with a referral code (NM- + 6 hex chars)
UPDATE users SET referral_code = 'NM-' || upper(substr(hex(randomblob(3)), 1, 6)) WHERE referral_code IS NULL;

-- 3. Create credit ledger table
CREATE TABLE IF NOT EXISTS credit_ledger (
    ledger_id   TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    category    TEXT NOT NULL,  -- 'signup_bonus' | 'referral_reward' | 'gas_earned' | 'compute_cost' | 'topup'
    amount      REAL NOT NULL,
    balance     REAL NOT NULL,
    title       TEXT NOT NULL,
    detail      TEXT,
    related_id  TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_category ON credit_ledger(user_id, category);

-- 4. Backfill signup_bonus ledger entry for ALL existing users
INSERT INTO credit_ledger (ledger_id, user_id, category, amount, balance, title, detail)
SELECT
    lower(hex(randomblob(16))),
    user_id,
    'signup_bonus',
    10000,
    credits,
    'Signup Bonus',
    'Welcome credit pack'
FROM users;
