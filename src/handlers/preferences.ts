import type { Env } from '../env';
import type { AuthContext } from '../auth';
import { json } from '../helpers/helpers';

const VALID_CURRENCIES = ['UYU', 'USD', 'EUR', 'ARS'] as const;

interface PreferencesRow {
  user_id: string;
  default_currency: string;
  timezone: string;
  reminder_days_before: number;
  notify_by_email: number;
  notify_by_web_push: number;
  updated_at: number;
}

interface PreferencesDto {
  defaultCurrency: string;
  timezone: string;
  reminderDaysBefore: number;
  notifyByEmail: boolean;
  notifyByWebPush: boolean;
  updatedAt: string;
}

const DEFAULTS = {
  defaultCurrency: 'UYU',
  timezone: 'America/Montevideo',
  reminderDaysBefore: 3,
  notifyByEmail: true,
  notifyByWebPush: true,
};

function toDto(row: PreferencesRow): PreferencesDto {
  return {
    defaultCurrency: row.default_currency,
    timezone: row.timezone,
    reminderDaysBefore: row.reminder_days_before,
    notifyByEmail: row.notify_by_email === 1,
    notifyByWebPush: row.notify_by_web_push === 1,
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
  };
}

export async function getPreferences(
  _req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const row = await env.vence_db.prepare(
    `SELECT * FROM user_preferences WHERE user_id = ?1`
  ).bind(auth.sub).first<PreferencesRow>();

  if (!row) {
    return json({
      ...DEFAULTS,
      updatedAt: null,
    }, 200, cors);
  }

  return json(toDto(row), 200, cors);
}

export async function updatePreferences(
  req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Body inválido' }, 400, cors);

  // Load existing so partial updates work
  const existing = await env.vence_db.prepare(
    `SELECT * FROM user_preferences WHERE user_id = ?1`
  ).bind(auth.sub).first<PreferencesRow>();

  const merged = {
    default_currency: DEFAULTS.defaultCurrency,
    timezone: DEFAULTS.timezone,
    reminder_days_before: DEFAULTS.reminderDaysBefore,
    notify_by_email: 1,
    notify_by_web_push: 1,
    ...(existing ?? {}),
  };

  if (body.defaultCurrency !== undefined) {
    if (
      typeof body.defaultCurrency !== 'string' ||
      !(VALID_CURRENCIES as readonly string[]).includes(body.defaultCurrency)
    ) {
      return json(
        { error: `defaultCurrency inválida (valores: ${VALID_CURRENCIES.join(', ')})` },
        400,
        cors
      );
    }
    merged.default_currency = body.defaultCurrency;
  }

  if (body.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || body.timezone.length > 64) {
      return json({ error: 'timezone inválida' }, 400, cors);
    }
    merged.timezone = body.timezone;
  }

  if (body.reminderDaysBefore !== undefined) {
    if (
      typeof body.reminderDaysBefore !== 'number' ||
      !Number.isInteger(body.reminderDaysBefore) ||
      body.reminderDaysBefore < 0 ||
      body.reminderDaysBefore > 30
    ) {
      return json({ error: 'reminderDaysBefore debe ser un entero entre 0 y 30' }, 400, cors);
    }
    merged.reminder_days_before = body.reminderDaysBefore;
  }

  if (body.notifyByEmail !== undefined) {
    if (typeof body.notifyByEmail !== 'boolean') {
      return json({ error: 'notifyByEmail debe ser booleano' }, 400, cors);
    }
    merged.notify_by_email = body.notifyByEmail ? 1 : 0;
  }

  if (body.notifyByWebPush !== undefined) {
    if (typeof body.notifyByWebPush !== 'boolean') {
      return json({ error: 'notifyByWebPush debe ser booleano' }, 400, cors);
    }
    merged.notify_by_web_push = body.notifyByWebPush ? 1 : 0;
  }

  await env.vence_db.prepare(
    `INSERT INTO user_preferences
       (user_id, default_currency, timezone, reminder_days_before,
        notify_by_email, notify_by_web_push, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch(), unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET
       default_currency = excluded.default_currency,
       timezone = excluded.timezone,
       reminder_days_before = excluded.reminder_days_before,
       notify_by_email = excluded.notify_by_email,
       notify_by_web_push = excluded.notify_by_web_push,
       updated_at = unixepoch()`
  ).bind(
    auth.sub,
    merged.default_currency,
    merged.timezone,
    merged.reminder_days_before,
    merged.notify_by_email,
    merged.notify_by_web_push,
  ).run();

  const row = await env.vence_db.prepare(
    `SELECT * FROM user_preferences WHERE user_id = ?1`
  ).bind(auth.sub).first<PreferencesRow>();

  return json(toDto(row!), 200, cors);
}