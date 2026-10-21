-- One-time backfill, run only on databases migrated before the deploy pipeline
-- adopted `wrangler d1 migrations apply`.
--
-- 0001 and 0002 were applied by hand with `d1 execute --file`, which keeps no
-- record. Wrangler therefore sees them as pending and replays them, where 0001
-- fails on a FOREIGN KEY violation (it rebuilds tables that are already
-- rebuilt) and 0002 on `duplicate column name: notify_by_push`.
--
-- This writes the ledger rows those runs would have written. It asserts nothing
-- about the schema -- verify first that providers.category already admits
-- 'seguro' and 'patente', and that push_tokens and reminder_log exist.
--
--   npx wrangler d1 execute vence-db --remote --yes --file=src/db/bootstrap-migration-ledger.sql
--
-- Safe to re-run: the table is created only if absent and the inserts ignore
-- duplicates.

-- Column types copied verbatim from wrangler's getCreateMigrationsTableQuery.
CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_widen_category_and_tier_checks.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_push_notifications.sql');
