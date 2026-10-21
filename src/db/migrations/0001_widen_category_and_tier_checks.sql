-- 0001 — widen two CHECK constraints that were rejecting values the app sends.
--
--   providers.category   + 'seguro', 'patente'   (the frontend has always offered
--                                                 both; the worker returned 400)
--   subscriptions.tier   + 'personal'            (PLANS, PricingPage and
--                                                 CheckoutModal all offer it; the
--                                                 INSERT in createCheckout failed
--                                                 *after* the MP preapproval was
--                                                 already created)
--
-- SQLite cannot ALTER a CHECK, so each table is recreated and its rows copied.
-- defer_foreign_keys lets us drop `providers` while `bills` still references it;
-- the reference resolves again as soon as the new table takes the old name.
--
-- Apply:
--   wrangler d1 execute vence-db --remote --file=src/db/migrations/0001_widen_category_and_tier_checks.sql
-- Dry-run against the local copy first by swapping --remote for --local.

PRAGMA defer_foreign_keys = on;

-- ── providers ────────────────────────────────────────────────────────────────

CREATE TABLE providers_new (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN (
                'servicios','internet','suscripcion','profesional',
                'impuesto','alquiler','tarjeta','seguro','patente','otro'
              )),
  notes       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at  INTEGER
);

INSERT INTO providers_new (id, user_id, name, category, notes, created_at, updated_at, deleted_at)
  SELECT id, user_id, name, category, notes, created_at, updated_at, deleted_at FROM providers;

DROP TABLE providers;
ALTER TABLE providers_new RENAME TO providers;

CREATE INDEX IF NOT EXISTS idx_providers_user_active
  ON providers(user_id, name) WHERE deleted_at IS NULL;

-- ── subscriptions ────────────────────────────────────────────────────────────

CREATE TABLE subscriptions_new (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier                      TEXT NOT NULL CHECK (tier IN ('free','personal','pro')),
  status                    TEXT NOT NULL CHECK (status IN (
                              'active','trialing','past_due','cancelled','expired'
                            )),
  provider                  TEXT CHECK (provider IN ('mercadopago','stripe','manual')),
  provider_customer_id      TEXT,
  provider_subscription_id  TEXT,
  current_period_end        INTEGER,
  cancel_at_period_end      INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  metadata                  TEXT,
  created_at                INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at                INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO subscriptions_new (
    id, user_id, tier, status, provider, provider_customer_id,
    provider_subscription_id, current_period_end, cancel_at_period_end,
    metadata, created_at, updated_at)
  SELECT
    id, user_id, tier, status, provider, provider_customer_id,
    provider_subscription_id, current_period_end, cancel_at_period_end,
    metadata, created_at, updated_at FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user_current
  ON subscriptions(user_id)
  WHERE status IN ('active','trialing');
