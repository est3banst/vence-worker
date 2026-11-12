import type { Env } from '../env';

export const DEFAULT_TZ = 'America/Montevideo';

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

/**
 * Today from the caller's own point of view.
 *
 * Whether a bill is late is a question about the calendar on the user's wall,
 * not in UTC. Uruguay is UTC-3, so from 21:00 local the UTC date is already
 * tomorrow — and a bill due today was being labelled `vencida` for the last
 * three hours of the day it was actually due. Anything that compares a
 * `due_date` against "now" has to come through here.
 */
export async function userToday(env: Env, userId: string): Promise<string> {
  const row = await env.vence_db.prepare(
    `SELECT timezone FROM user_preferences WHERE user_id = ?1`
  ).bind(userId).first<{ timezone: string }>();
  return todayIn(row?.timezone ?? DEFAULT_TZ);
}
