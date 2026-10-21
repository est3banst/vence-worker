import { env } from 'cloudflare:test';
import schemaSql from '../../src/db/schema.sql?raw';
import migration0001 from '../../src/db/migrations/0001_widen_category_and_tier_checks.sql?raw';
import migration0002 from '../../src/db/migrations/0002_push_notifications.sql?raw';
import migration0003 from '../../src/db/migrations/0003_reminder_slots.sql?raw';

/**
 * Splits a .sql file into executable statements.
 *
 * D1's `exec` is fussy about comments and blank lines, so strip `--` comments
 * first. Naive `;` splitting is safe here because none of our schema contains a
 * semicolon inside a string literal or a trigger body.
 */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * D1's `exec` parses one statement per line, so multi-line DDL fails on it.
 * `prepare().run()` has no such limitation.
 */
async function execAll(sql: string, skip?: (stmt: string) => boolean): Promise<void> {
  for (const stmt of statements(sql)) {
    if (skip?.(stmt)) continue;
    await env.vence_db.prepare(stmt).run();
  }
}

/**
 * Builds the real production schema, then applies the migrations on top — the
 * same order a fresh environment goes through. Running the migrations (rather
 * than just the already-updated schema.sql) means a broken migration fails the
 * test suite instead of being discovered in production.
 *
 * Call from `beforeAll`. vitest-pool-workers runs with isolated storage, so
 * each test's own writes are rolled back afterwards while this setup persists
 * for the file.
 */
export async function applySchema(): Promise<void> {
  await execAll(schemaSql);

  // schema.sql already carries everything 0001 widened and 0002's new column,
  // so replaying them whole would be redundant or outright conflict. What still
  // matters is 0002's new tables (push_tokens, reminder_log), so apply those and
  // skip the ALTER whose column already exists.
  await execAll(migration0002, stmt => stmt.startsWith('ALTER TABLE'));

  // 0003 rebuilds reminder_log to widen its primary key, so it runs in full on
  // top of the table 0002 just created — the same two steps production takes.
  await execAll(migration0003);
  void migration0001;
}

export const USER_A = 'cognito-sub-aaaa';
export const USER_B = 'cognito-sub-bbbb';

/** Clears every table. Use in `beforeEach` so tests never see each other's rows. */
export async function reset(): Promise<void> {
  const tables = [
    'reminder_log', 'push_tokens', 'documents', 'bills',
    'providers', 'subscriptions', 'user_preferences', 'users',
  ];
  for (const t of tables) {
    await env.vence_db.prepare(`DELETE FROM ${t}`).run();
  }
}

export async function seedUser(id = USER_A, email = 'a@vence.uy'): Promise<void> {
  await env.vence_db
    .prepare('INSERT INTO users (id, email) VALUES (?1, ?2)')
    .bind(id, email)
    .run();
}

export async function seedProvider(opts: {
  id: string; userId?: string; name?: string; category?: string;
}): Promise<string> {
  await env.vence_db.prepare(
    `INSERT INTO providers (id, user_id, name, category)
     VALUES (?1, ?2, ?3, ?4)`
  ).bind(opts.id, opts.userId ?? USER_A, opts.name ?? 'UTE', opts.category ?? 'servicios').run();
  return opts.id;
}

export async function seedBill(opts: {
  id: string; providerId: string; userId?: string;
  amount?: number; currency?: string; dueDate?: string;
  frequency?: string; paidAt?: string | null;
}): Promise<string> {
  await env.vence_db.prepare(
    `INSERT INTO bills
       (id, user_id, provider_id, amount, currency, due_date, frequency, status, paid_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(
    opts.id,
    opts.userId ?? USER_A,
    opts.providerId,
    opts.amount ?? 1200,
    opts.currency ?? 'UYU',
    opts.dueDate ?? '2026-11-10',
    opts.frequency ?? 'mensual',
    opts.paidAt ? 'pagada' : 'pendiente',
    opts.paidAt ?? null,
  ).run();
  return opts.id;
}

/**
 * A date offset from **UTC** today, as YYYY-MM-DD.
 *
 * Tests compute "today" from the real clock rather than faking timers: several
 * queries use SQLite's own `date('now')`, which vitest's fake timers cannot
 * reach, so a faked JS clock would disagree with the database.
 *
 * Use this for anything compared against `date('now')` in SQL — that is UTC.
 * For the reminder sweep, which measures from each user's own timezone, use
 * `isoDaysFromLocalToday` instead.
 */
export function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A date offset from today **in the given timezone**, as YYYY-MM-DD.
 *
 * The reminder sweep decides what is due using `todayIn(user.timezone)`, not
 * UTC. Between 00:00 and 03:00 UTC those are different calendar days in
 * Montevideo (UTC-3), so seeding a window-boundary date in UTC makes the test
 * pass by day and fail by night. Seed from the same clock the code reads.
 */
export function isoDaysFromLocalToday(days: number, timezone = 'America/Montevideo'): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const [y, m, d] = today.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}
