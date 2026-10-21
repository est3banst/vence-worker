-- 0002 — device push tokens, a per-day send log, and a push preference.
--
-- Apply:
--   wrangler d1 execute vence-db --remote --file=src/db/migrations/0002_push_notifications.sql

-- One row per device. The token is the natural key: Expo hands back the same
-- ExponentPushToken for a given install, and reinstalls produce a new one.
CREATE TABLE IF NOT EXISTS push_tokens (
  token         TEXT PRIMARY KEY,                     -- ExponentPushToken[...]
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      TEXT CHECK (platform IN ('ios','android')),
  device_name   TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  -- Set when Expo reports DeviceNotRegistered. Kept rather than deleted so a
  -- reinstall on the same device doesn't look like a brand-new row.
  disabled_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user_active
  ON push_tokens(user_id) WHERE disabled_at IS NULL;

-- Makes the daily sweep idempotent: one reminder per user per local day, so a
-- cron retry or a manual re-run can't double-notify.
CREATE TABLE IF NOT EXISTS reminder_log (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_on   TEXT NOT NULL,                            -- 'YYYY-MM-DD' in the user's timezone
  bill_count INTEGER NOT NULL,
  sent_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, sent_on)
);

-- Mobile push is a separate channel from the existing web-push toggle.
-- ALTER ADD COLUMN with a default needs no table rewrite.
ALTER TABLE user_preferences
  ADD COLUMN notify_by_push INTEGER NOT NULL DEFAULT 1 CHECK (notify_by_push IN (0,1));
