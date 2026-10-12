-- Migration: 0007_recharge.sql
-- Gift codes (single-use), attempts log, admin login attempts, and reserved payment orders

-- 1. Single-use gift codes (hashed storage)
CREATE TABLE IF NOT EXISTS gift_codes (
  code_id        TEXT PRIMARY KEY,
  code_hash      TEXT NOT NULL UNIQUE,            -- SHA-256(normalized_code + JWT_SECRET)
  code_hint      TEXT NOT NULL,                   -- Last 4 characters (e.g., HD2W)
  amount         REAL NOT NULL CHECK (amount > 0),
  status         TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'redeemed' | 'revoked'
  expires_at     TEXT,                            -- UTC 'YYYY-MM-DD HH:MM:SS' or NULL (never expires)
  redemption_id  TEXT UNIQUE,                     -- Unique UUID written on redemption (race guard)
  redeemed_by    TEXT,                            -- user_id
  redeemed_at    TEXT,
  revoked_at     TEXT,
  batch_id       TEXT NOT NULL,                   -- Batch identifier (UUID)
  note           TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gift_codes_status ON gift_codes(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gift_codes_batch  ON gift_codes(batch_id);

-- 2. User redeem attempts (brute-force rate limiting: 5 fails / 10 mins)
CREATE TABLE IF NOT EXISTS redeem_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_redeem_attempts ON redeem_attempts(user_id, created_at);

-- 3. Admin login attempts (brute-force rate limiting: 5 fails / 15 mins per IP)
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts ON admin_login_attempts(ip, created_at);

-- 4. Reserved payment orders table (for upcoming Crypto, PayPal, VISA/Master)
CREATE TABLE IF NOT EXISTS payment_orders (
  order_id       TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  method         TEXT NOT NULL,                   -- 'crypto' | 'paypal' | 'card'
  package_id     TEXT NOT NULL,                   -- 'pkg_10k' | 'pkg_50k' | 'custom'
  credits        REAL NOT NULL,
  price_cents    INTEGER NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  promo_code     TEXT,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'failed' | 'expired' | 'refunded'
  provider_ref   TEXT UNIQUE,                     -- Third-party payment ID (idempotency key)
  created_at     TEXT DEFAULT (datetime('now')),
  paid_at        TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id, created_at DESC);
