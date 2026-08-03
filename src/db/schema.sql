-- Vence — full initial schema.
-- Run once per environment. Safe to re-run: tables and indexes use IF NOT EXISTS.
-- ALTER statements for future changes: run them by hand against local + remote.

-- ─────────────────────────────────────────────────────────
-- users
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                     -- Cognito sub
  email         TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ─────────────────────────────────────────────────────────
-- providers
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS providers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN (
                'servicios','internet','suscripcion','profesional',
                'impuesto','alquiler','tarjeta','otro'
              )),
  notes       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_providers_user_active
  ON providers(user_id, name) WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────
-- bills
-- ─────────────────────────────────────────────────────────
-- Money stored as REAL for the MVP. Migrate to INTEGER cents when you start
-- aggregating (analytics view), floating point rounding will bite.

CREATE TABLE IF NOT EXISTS bills (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id   TEXT NOT NULL REFERENCES providers(id),
  amount        REAL NOT NULL CHECK (amount > 0),
  currency      TEXT NOT NULL CHECK (currency IN ('UYU','USD','EUR','ARS')),
  due_date      TEXT NOT NULL,                        -- 'YYYY-MM-DD'
  frequency     TEXT NOT NULL CHECK (frequency IN (
                  'unica','mensual','bimestral','trimestral','semestral','anual'
                )),
  status        TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN (
                  'pendiente','pagada','vencida'
                )),
  reference     TEXT,                                 -- CFE serie/nro or free-text
  notes         TEXT,
  paid_at       TEXT,                                 -- ISO 8601
  amount_paid   REAL,                                 -- may differ from amount
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bills_user_due_active
  ON bills(user_id, due_date) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bills_user_provider_active
  ON bills(user_id, provider_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bills_user_status_active
  ON bills(user_id, status) WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────
-- documents (PDF metadata; bytes live in R2)
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,                     -- UUID returned to clients
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bill_id       TEXT NOT NULL REFERENCES bills(id),
  r2_key        TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  size          INTEGER NOT NULL,
  content_type  TEXT NOT NULL,
  uploaded_at   TEXT NOT NULL,                        -- ISO 8601
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_documents_user_bill_active
  ON documents(user_id, bill_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_user_uploaded_active
  ON documents(user_id, uploaded_at DESC) WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────
-- subscriptions (Vence's monetization, not user's bills)
-- ─────────────────────────────────────────────────────────
-- One "active" or "trialing" row per user enforced by the partial unique index.

CREATE TABLE IF NOT EXISTS subscriptions (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier                      TEXT NOT NULL CHECK (tier IN ('free','pro')),
  status                    TEXT NOT NULL CHECK (status IN (
                              'active','trialing','past_due','cancelled','expired'
                            )),
  provider                  TEXT CHECK (provider IN ('mercadopago','stripe','manual')),
  provider_customer_id      TEXT,
  provider_subscription_id  TEXT,
  current_period_end        INTEGER,                  -- unix ts; null for free
  cancel_at_period_end      INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  metadata                  TEXT,                     -- JSON escape hatch
  created_at                INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at                INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user_current
  ON subscriptions(user_id)
  WHERE status IN ('active','trialing');

-- ─────────────────────────────────────────────────────────
-- user_preferences (created lazily on first save)
-- ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id               TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_currency      TEXT NOT NULL DEFAULT 'UYU' CHECK (default_currency IN ('UYU','USD','EUR','ARS')),
  timezone              TEXT NOT NULL DEFAULT 'America/Montevideo',
  reminder_days_before  INTEGER NOT NULL DEFAULT 3 CHECK (reminder_days_before BETWEEN 0 AND 30),
  notify_by_email       INTEGER NOT NULL DEFAULT 1 CHECK (notify_by_email IN (0,1)),
  notify_by_web_push    INTEGER NOT NULL DEFAULT 1 CHECK (notify_by_web_push IN (0,1)),
  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
);