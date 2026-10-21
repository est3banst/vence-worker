import type { Env } from '../env';
import { sendPush, type PushMessage } from './expo';
import { disableTokens } from '../handlers/push';

const DEFAULT_TZ = 'America/Montevideo';
const DEFAULT_DAYS_BEFORE = 3;

// Bounds the scan. Anything further out can't be inside a 0-30 day window.
const SCAN_HORIZON_DAYS = 31;

/**
 * Which pass of the day a sweep is. A single daily notification is easy to
 * miss, so the cron fires more than once; the slot is what keeps the later
 * passes from being skipped as duplicates of the day's first one, and what
 * makes them read differently on a lock screen.
 */
export type ReminderSlot = 'morning' | 'evening';

/**
 * Keyed by the cron expression rather than read off the clock at run time: the
 * slot is then exact and testable, and a retry an hour late still belongs to
 * the pass it was scheduled for. Keep in step with `triggers.crons` in
 * wrangler.jsonc.
 */
const SLOT_BY_CRON: Record<string, ReminderSlot> = {
  '0 11 * * *': 'morning',  // 08:00 in Uruguay (UTC-3, no DST)
  '0 21 * * *': 'evening',  // 18:00 in Uruguay
};

/**
 * An unmapped cron falls back to the morning slot, which that day's morning
 * pass has usually already claimed, so the run sends nothing. Erring towards a
 * missed reminder beats erring towards an unexplained second buzz — but it is a
 * misconfiguration either way, so say so in the logs.
 */
export function slotForCron(cron: string): ReminderSlot {
  const slot = SLOT_BY_CRON[cron];
  if (!slot) {
    console.warn(`unmapped cron ${cron}; add it to SLOT_BY_CRON. Falling back to morning.`);
    return 'morning';
  }
  return slot;
}

// Two passes with identical text look like a glitch rather than a reminder, so
// the later one names itself.
const SLOT_TITLE_PREFIX: Record<ReminderSlot, string> = {
  morning: '',
  evening: 'Recordatorio: ',
};

interface DueRow {
  user_id: string;
  timezone: string;
  reminder_days_before: number;
  bill_id: string;
  due_date: string;
  amount: number;
  currency: string;
  provider_name: string | null;
}

const SYMBOL: Record<string, string> = { UYU: '$', USD: 'US$', EUR: '€', ARS: 'AR$' };

function formatAmount(amount: number, currency: string): string {
  const n = amount.toLocaleString('es-UY', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${SYMBOL[currency] ?? currency} ${n}`;
}

/**
 * Today as YYYY-MM-DD in a given IANA zone. en-CA formats as ISO, which saves
 * reassembling parts by hand. An unknown zone would throw, so fall back.
 */
export function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. Negative means past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export function describeDue(days: number): string {
  if (days < -1) return `vencida hace ${-days} días`;
  if (days === -1) return 'vencida ayer';
  if (days === 0) return 'vence hoy';
  if (days === 1) return 'vence mañana';
  return `vence en ${days} días`;
}

interface Reminder {
  title: string;
  body: string;
  billCount: number;
}

/**
 * Compose one notification per user rather than one per bill — a person with
 * five bills due wants a single summary, not five buzzes. The slot only shapes
 * the wording; which bills qualify is the same in every pass.
 */
export function composeReminder(
  bills: { label: string; days: number }[],
  slot: ReminderSlot = 'morning',
): Reminder | null {
  if (bills.length === 0) return null;

  const sorted = [...bills].sort((a, b) => a.days - b.days);
  const overdue = sorted.filter(b => b.days < 0).length;
  const n = sorted.length;

  const headline = overdue > 0
    ? `${overdue} cuenta${overdue === 1 ? '' : 's'} vencida${overdue === 1 ? '' : 's'}`
    : `${n} cuenta${n === 1 ? '' : 's'} por vencer`;
  const title = `${SLOT_TITLE_PREFIX[slot]}${headline}`;

  // Three lines keeps the notification readable on a lock screen.
  const shown = sorted.slice(0, 3).map(b => b.label);
  const rest = n - shown.length;
  const body = rest > 0 ? `${shown.join(' · ')} y ${rest} más` : shown.join(' · ');

  return { title, body, billCount: n };
}

export interface SweepSummary {
  slot: ReminderSlot;
  usersConsidered: number;
  usersNotified: number;
  pushesSent: number;
  tokensDisabled: number;
  skippedAlreadySent: number;
  errors: string[];
}

/**
 * One pass of the daily sweep. Idempotent per user per local day *per slot* via
 * reminder_log, so a cron retry or a manual re-run cannot double-notify, while
 * the day's other passes still get through.
 */
export async function runDailyReminders(
  env: Env,
  slot: ReminderSlot = 'morning',
): Promise<SweepSummary> {
  const summary: SweepSummary = {
    slot,
    usersConsidered: 0, usersNotified: 0, pushesSent: 0,
    tokensDisabled: 0, skippedAlreadySent: 0, errors: [],
  };

  // Only users who actually have a live device and haven't muted push.
  const rows = await env.vence_db.prepare(
    `SELECT
       d.user_id,
       COALESCE(pf.timezone, ?1)             AS timezone,
       COALESCE(pf.reminder_days_before, ?2) AS reminder_days_before,
       b.id        AS bill_id,
       b.due_date,
       b.amount,
       b.currency,
       p.name      AS provider_name
     FROM (SELECT DISTINCT user_id FROM push_tokens WHERE disabled_at IS NULL) d
     LEFT JOIN user_preferences pf ON pf.user_id = d.user_id
     JOIN bills b
       ON b.user_id = d.user_id AND b.deleted_at IS NULL AND b.paid_at IS NULL
     LEFT JOIN providers p ON p.id = b.provider_id
     WHERE COALESCE(pf.notify_by_push, 1) = 1
       AND date(b.due_date) <= date('now', ?3)
     ORDER BY d.user_id, b.due_date`
  ).bind(DEFAULT_TZ, DEFAULT_DAYS_BEFORE, `+${SCAN_HORIZON_DAYS} days`).all<DueRow>();

  const byUser = new Map<string, DueRow[]>();
  for (const row of rows.results ?? []) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  summary.usersConsidered = byUser.size;

  const messages: PushMessage[] = [];
  // Slots we claimed in reminder_log, so a total send failure can release them.
  const claimed: { userId: string; day: string }[] = [];

  for (const [userId, userBills] of byUser) {
    const { timezone, reminder_days_before } = userBills[0];
    const today = todayIn(timezone);

    // Due within the window, or already overdue.
    const relevant = userBills
      .map(b => ({ row: b, days: daysBetween(today, b.due_date) }))
      .filter(({ days }) => days <= reminder_days_before);

    const reminder = composeReminder(relevant.map(({ row, days }) => ({
      label: `${row.provider_name ?? 'Cuenta'} ${formatAmount(row.amount, row.currency)} ${describeDue(days)}`,
      days,
    })), slot);
    if (!reminder) continue;

    // Claim this slot of the day for this user first. If the row already
    // exists we've already run this pass, so skip rather than buzz twice.
    const claim = await env.vence_db.prepare(
      `INSERT INTO reminder_log (user_id, sent_on, slot, bill_count)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, sent_on, slot) DO NOTHING`
    ).bind(userId, today, slot, reminder.billCount).run();

    if ((claim.meta?.changes ?? 0) === 0) {
      summary.skippedAlreadySent++;
      continue;
    }

    const tokens = await env.vence_db.prepare(
      `SELECT token FROM push_tokens WHERE user_id = ?1 AND disabled_at IS NULL`
    ).bind(userId).all<{ token: string }>();

    for (const { token } of tokens.results ?? []) {
      messages.push({
        to: token,
        title: reminder.title,
        body: reminder.body,
        data: { kind: 'reminder', slot, billIds: relevant.map(r => r.row.bill_id) },
        channelId: 'reminders',
      });
    }
    claimed.push({ userId, day: today });
    summary.usersNotified++;
  }

  if (messages.length > 0) {
    const result = await sendPush(env, messages);
    summary.pushesSent = result.sent;
    summary.errors.push(...result.errors);

    if (result.deadTokens.length) {
      await disableTokens(env, result.deadTokens);
      summary.tokensDisabled = result.deadTokens.length;
    }

    // The slot is claimed before sending so a retry can't buzz anyone twice.
    // But if nothing got through at all, that claim would silently cost the
    // user a reminder — so release it and let the next run try again.
    if (result.sent === 0 && result.errors.length > 0) {
      await env.vence_db.batch(
        claimed.map(c =>
          env.vence_db.prepare(
            `DELETE FROM reminder_log WHERE user_id = ?1 AND sent_on = ?2 AND slot = ?3`
          ).bind(c.userId, c.day, slot)
        )
      );
      summary.usersNotified = 0;
      summary.errors.push(`all sends failed; released the ${slot} claims for retry`);
    }
  }

  return summary;
}
