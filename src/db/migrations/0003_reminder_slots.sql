-- 0003 — a second reminder pass each day.
--
-- One notification a day is easy to miss, so the sweep now runs more than once
-- (morning and evening in Uruguay). The send log was keyed on (user_id,
-- sent_on) alone, which made every pass after the first look like a duplicate
-- of the day's first one and get skipped. The slot joins the key so each pass
-- claims its own row.
--
-- SQLite cannot widen a primary key in place, so the table is rebuilt. Existing
-- rows are the old single daily send, which went out in the morning.
--
-- Apply:
--   wrangler d1 migrations apply vence-db --remote

CREATE TABLE reminder_log_v2 (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_on    TEXT NOT NULL,                           -- 'YYYY-MM-DD' in the user's timezone
  -- Which pass of the day. Deliberately unconstrained: the slots live in
  -- SLOT_BY_CRON next to the crons, so adding one is a code change, not a
  -- migration.
  slot       TEXT NOT NULL DEFAULT 'morning',
  bill_count INTEGER NOT NULL,
  sent_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, sent_on, slot)
);

INSERT INTO reminder_log_v2 (user_id, sent_on, slot, bill_count, sent_at)
  SELECT user_id, sent_on, 'morning', bill_count, sent_at FROM reminder_log;

DROP TABLE reminder_log;

ALTER TABLE reminder_log_v2 RENAME TO reminder_log;
