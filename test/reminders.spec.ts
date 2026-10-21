import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env, createScheduledController, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { runDailyReminders, slotForCron, composeReminder } from '../src/notifications/reminders';
import {
  applySchema, reset, seedUser, seedProvider, seedBill,
  isoDaysFromLocalToday, USER_A, USER_B,
} from './helpers/db';

beforeAll(applySchema);
beforeEach(async () => {
  await reset();
  await seedUser(USER_A);
  await seedUser(USER_B, 'b@vence.uy');
  await seedProvider({ id: 'p-1', userId: USER_A, name: 'UTE' });
});
afterEach(() => { vi.restoreAllMocks(); });

const TOKEN_A = 'ExponentPushToken[AAAAAAAAAAAAAAAAAAAAAA]';
const TOKEN_A2 = 'ExponentPushToken[CCCCCCCCCCCCCCCCCCCCCC]';
const TOKEN_B = 'ExponentPushToken[BBBBBBBBBBBBBBBBBBBBBB]';

interface SentMessage {
  to: string;
  title: string;
  body: string;
  channelId?: string;
  data?: { kind?: string; slot?: string; billIds?: string[] };
}

/**
 * Captures what would have gone to Expo, and replies with the given tickets.
 *
 * Expo's two endpoints answer different shapes: /push/send an array of tickets,
 * /push/getReceipts a map keyed by ticket id. `makeReceipts` left undefined
 * means every accepted ticket comes back delivered.
 */
function stubExpo(
  makeTickets?: (msgs: SentMessage[]) => unknown[],
  makeReceipts?: (ids: string[]) => Record<string, unknown>,
) {
  const sent: SentMessage[] = [];
  let nextTicket = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (!url.includes('exp.host')) throw new Error(`unexpected fetch to ${url}`);
    const body = JSON.parse((init as RequestInit).body as string) as
      | SentMessage[]
      | { ids: string[] };

    if (url.includes('getReceipts')) {
      const { ids } = body as { ids: string[] };
      const data = makeReceipts?.(ids)
        ?? Object.fromEntries(ids.map(id => [id, { status: 'ok' }]));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }

    const batch = body as SentMessage[];
    sent.push(...batch);
    // Distinct ids, so a receipt can be aimed at one message of a batch.
    const tickets = makeTickets?.(batch)
      ?? batch.map(() => ({ status: 'ok', id: `tk-${nextTicket++}` }));
    return new Response(JSON.stringify({ data: tickets }), { status: 200 });
  });
  return sent;
}

async function registerToken(token: string, userId = USER_A) {
  await env.vence_db.prepare(
    `INSERT INTO push_tokens (token, user_id, platform) VALUES (?1, ?2, 'android')`
  ).bind(token, userId).run();
}

async function setPrefs(userId: string, patch: Partial<{ reminder_days_before: number; notify_by_push: number; timezone: string }>) {
  await env.vence_db.prepare(
    `INSERT INTO user_preferences (user_id, reminder_days_before, notify_by_push, timezone)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id) DO UPDATE SET
       reminder_days_before = excluded.reminder_days_before,
       notify_by_push = excluded.notify_by_push,
       timezone = excluded.timezone`
  ).bind(
    userId,
    patch.reminder_days_before ?? 3,
    patch.notify_by_push ?? 1,
    patch.timezone ?? 'America/Montevideo',
  ).run();
}

describe('runDailyReminders', () => {
  it('does nothing when nobody has a device', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });
    const spy = vi.spyOn(globalThis, 'fetch');

    const summary = await runDailyReminders(env);
    expect(summary).toMatchObject({ usersConsidered: 0, usersNotified: 0, pushesSent: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('notifies a user whose bill falls inside the reminder window', async () => {
    await registerToken(TOKEN_A);
    await setPrefs(USER_A, { reminder_days_before: 3 });
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(2), amount: 1200 });

    const sent = stubExpo();
    const summary = await runDailyReminders(env);

    expect(summary).toMatchObject({ usersConsidered: 1, usersNotified: 1, pushesSent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: TOKEN_A, title: '1 cuenta por vencer', channelId: 'reminders' });
    expect(sent[0].body).toContain('UTE');
  });

  it('leaves a bill beyond the window alone', async () => {
    await registerToken(TOKEN_A);
    await setPrefs(USER_A, { reminder_days_before: 3 });
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(10) });

    const sent = stubExpo();
    const summary = await runDailyReminders(env);
    expect(summary.usersNotified).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('respects a widened reminder window', async () => {
    await registerToken(TOKEN_A);
    await setPrefs(USER_A, { reminder_days_before: 14 });
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(10) });

    stubExpo();
    expect((await runDailyReminders(env)).usersNotified).toBe(1);
  });

  it('includes an already-overdue bill and leads the title with it', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(-5) });

    const sent = stubExpo();
    await runDailyReminders(env);
    expect(sent[0].title).toBe('1 cuenta vencida');
  });

  it('skips a paid bill', async () => {
    await registerToken(TOKEN_A);
    await seedBill({
      id: 'b-1', providerId: 'p-1',
      dueDate: isoDaysFromLocalToday(1), paidAt: new Date().toISOString(),
    });
    stubExpo();
    expect((await runDailyReminders(env)).usersNotified).toBe(0);
  });

  it('skips a soft-deleted bill', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });
    await env.vence_db.prepare(`UPDATE bills SET deleted_at = unixepoch() WHERE id='b-1'`).run();
    stubExpo();
    expect((await runDailyReminders(env)).usersNotified).toBe(0);
  });

  it('honours notify_by_push = 0', async () => {
    await registerToken(TOKEN_A);
    await setPrefs(USER_A, { notify_by_push: 0 });
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    stubExpo();
    expect((await runDailyReminders(env)).usersConsidered).toBe(0);
  });

  it('treats a user with no preferences row as opted in with the 3-day default', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(3) });

    stubExpo();
    expect((await runDailyReminders(env)).usersNotified).toBe(1);
  });

  it('sends one message per device, but still counts the user once', async () => {
    await registerToken(TOKEN_A);
    await registerToken(TOKEN_A2);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    const sent = stubExpo();
    const summary = await runDailyReminders(env);
    expect(summary.usersNotified).toBe(1);
    expect(summary.pushesSent).toBe(2);
    expect(sent.map(m => m.to).sort()).toEqual([TOKEN_A, TOKEN_A2].sort());
  });

  it('skips a device Expo had already rejected', async () => {
    await registerToken(TOKEN_A);
    await registerToken(TOKEN_A2);
    await env.vence_db.prepare(
      'UPDATE push_tokens SET disabled_at = unixepoch() WHERE token = ?1'
    ).bind(TOKEN_A2).run();
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    const sent = stubExpo();
    await runDailyReminders(env);
    expect(sent.map(m => m.to)).toEqual([TOKEN_A]);
  });

  it('summarises several bills into a single notification', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(0) });
    await seedBill({ id: 'b-2', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });
    await seedBill({ id: 'b-3', providerId: 'p-1', dueDate: isoDaysFromLocalToday(2) });

    const sent = stubExpo();
    await runDailyReminders(env);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('3 cuentas por vencer');
  });

  it('keeps users separate', async () => {
    await seedProvider({ id: 'p-b', userId: USER_B, name: 'Antel' });
    await registerToken(TOKEN_A, USER_A);
    await registerToken(TOKEN_B, USER_B);
    await seedBill({ id: 'b-a', providerId: 'p-1', userId: USER_A, dueDate: isoDaysFromLocalToday(1) });
    await seedBill({ id: 'b-b', providerId: 'p-b', userId: USER_B, dueDate: isoDaysFromLocalToday(1) });

    const sent = stubExpo();
    const summary = await runDailyReminders(env);
    expect(summary.usersNotified).toBe(2);
    const byToken = new Map(sent.map(m => [m.to, m.body]));
    expect(byToken.get(TOKEN_A)).toContain('UTE');
    expect(byToken.get(TOKEN_B)).toContain('Antel');
  });
});

describe('idempotency', () => {
  it('does not notify the same user twice in one day', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    const sent = stubExpo();
    const first = await runDailyReminders(env);
    const second = await runDailyReminders(env);

    expect(first.usersNotified).toBe(1);
    expect(second.usersNotified).toBe(0);
    expect(second.skippedAlreadySent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('records the claim in reminder_log', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });
    stubExpo();
    await runDailyReminders(env);

    const row = await env.vence_db
      .prepare('SELECT user_id, sent_on, bill_count FROM reminder_log')
      .first<{ user_id: string; sent_on: string; bill_count: number }>();
    expect(row).toMatchObject({ user_id: USER_A, bill_count: 1 });
    expect(row?.sent_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('releases the claim when every send fails, so the next run retries', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    // Expo answers, but every ticket is an error.
    stubExpo(msgs => msgs.map(() => ({ status: 'error', message: 'ServiceUnavailable' })));
    const failed = await runDailyReminders(env);

    expect(failed.pushesSent).toBe(0);
    expect(failed.usersNotified).toBe(0);
    const { results } = await env.vence_db.prepare('SELECT user_id FROM reminder_log').all();
    expect(results).toHaveLength(0);

    // A later run with a healthy Expo gets through.
    vi.restoreAllMocks();
    const sent = stubExpo();
    const retried = await runDailyReminders(env);
    expect(retried.usersNotified).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('keeps the claim on a partial failure, so the delivered users are not re-notified', async () => {
    await seedProvider({ id: 'p-b', userId: USER_B });
    await registerToken(TOKEN_A, USER_A);
    await registerToken(TOKEN_B, USER_B);
    await seedBill({ id: 'b-a', providerId: 'p-1', userId: USER_A, dueDate: isoDaysFromLocalToday(1) });
    await seedBill({ id: 'b-b', providerId: 'p-b', userId: USER_B, dueDate: isoDaysFromLocalToday(1) });

    // One ok, one error — sent > 0, so claims stand.
    stubExpo(msgs => msgs.map((m, i) =>
      i === 0 ? { status: 'ok', id: 'tk' } : { status: 'error', message: 'MessageTooBig' }
    ));
    await runDailyReminders(env);

    const { results } = await env.vence_db.prepare('SELECT user_id FROM reminder_log').all();
    expect(results).toHaveLength(2);
  });
});

describe('dead token handling', () => {
  it('disables a token Expo reports as DeviceNotRegistered', async () => {
    await registerToken(TOKEN_A);
    await registerToken(TOKEN_A2);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    stubExpo(msgs => msgs.map(m =>
      m.to === TOKEN_A2
        ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
        : { status: 'ok', id: 'tk' }
    ));
    const summary = await runDailyReminders(env);

    expect(summary.tokensDisabled).toBe(1);
    const row = await env.vence_db
      .prepare('SELECT disabled_at FROM push_tokens WHERE token = ?1')
      .bind(TOKEN_A2).first<{ disabled_at: number | null }>();
    expect(row?.disabled_at).not.toBeNull();
  });

  it('survives Expo returning a non-200', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream exploded', { status: 503 })
    );

    const summary = await runDailyReminders(env);
    expect(summary.pushesSent).toBe(0);
    expect(summary.errors.join(' ')).toContain('503');
  });

  it('survives the network throwing', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

    const summary = await runDailyReminders(env);
    expect(summary.pushesSent).toBe(0);
    expect(summary.errors.join(' ')).toContain('ECONNRESET');
  });
});

describe('delivery receipts', () => {
  it('counts a delivered push', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    stubExpo();
    const summary = await runDailyReminders(env);
    expect(summary).toMatchObject({ pushesSent: 1, pushesDelivered: 1, tokensDisabled: 0 });
  });

  // The quiet failure: Expo accepts the message and the transport drops it,
  // which only the receipt reveals. Left unchecked, the sweep "sends" to this
  // token twice a day forever and the phone never makes a sound.
  it('retires a token the receipt reports as DeviceNotRegistered', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    stubExpo(undefined, ids => Object.fromEntries(ids.map(id => [id, {
      status: 'error',
      message: 'The recipient device is not registered with FCM.',
      details: { error: 'DeviceNotRegistered' },
    }])));

    const summary = await runDailyReminders(env);
    expect(summary.pushesSent).toBe(1);
    expect(summary.pushesDelivered).toBe(0);
    expect(summary.tokensDisabled).toBe(1);
    expect(summary.errors.join(' ')).toContain('not registered with FCM');

    const row = await env.vence_db
      .prepare('SELECT disabled_at FROM push_tokens WHERE token = ?1')
      .bind(TOKEN_A).first<{ disabled_at: number | null }>();
    expect(row?.disabled_at).not.toBeNull();
  });

  it('keeps a token whose receipt failed for a transient reason', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    stubExpo(undefined, ids => Object.fromEntries(ids.map(id => [id, {
      status: 'error', message: 'MessageRateExceeded', details: { error: 'MessageRateExceeded' },
    }])));

    const summary = await runDailyReminders(env);
    expect(summary.tokensDisabled).toBe(0);
    expect(summary.errors.join(' ')).toContain('MessageRateExceeded');

    const row = await env.vence_db
      .prepare('SELECT disabled_at FROM push_tokens WHERE token = ?1')
      .bind(TOKEN_A).first<{ disabled_at: number | null }>();
    expect(row?.disabled_at).toBeNull();
  });

  it('retires only the device whose receipt failed', async () => {
    await registerToken(TOKEN_A);
    await registerToken(TOKEN_A2);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    // Aim the failure at whichever ticket carried TOKEN_A2.
    let doomed = '';
    stubExpo(
      batch => batch.map((m, i) => {
        const id = `tk-${i}`;
        if (m.to === TOKEN_A2) doomed = id;
        return { status: 'ok', id };
      }),
      ids => Object.fromEntries(ids.map(id => [
        id,
        id === doomed
          ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok' },
      ])),
    );

    const summary = await runDailyReminders(env);
    expect(summary.pushesDelivered).toBe(1);
    expect(summary.tokensDisabled).toBe(1);

    const { results } = await env.vence_db
      .prepare('SELECT token FROM push_tokens WHERE disabled_at IS NULL')
      .all<{ token: string }>();
    expect(results.map(r => r.token)).toEqual([TOKEN_A]);
  });

  it('treats an undecided receipt as neither delivered nor dead', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    stubExpo(undefined, () => ({}));
    const summary = await runDailyReminders(env);
    expect(summary).toMatchObject({ pushesSent: 1, pushesDelivered: 0, tokensDisabled: 0 });
  });

  it('does not fail the sweep when the receipt call itself breaks', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      // First call is the send, second is the receipt lookup.
      if (call === 1) return new Response(JSON.stringify({ data: [{ status: 'ok', id: 'tk-0' }] }), { status: 200 });
      return new Response('receipts down', { status: 502 });
    });

    const summary = await runDailyReminders(env);
    expect(summary.pushesSent).toBe(1);
    expect(summary.tokensDisabled).toBe(0);
    expect(summary.errors.join(' ')).toContain('502');

    // The claim stands: the push itself was accepted, so no retry is owed.
    const { results } = await env.vence_db.prepare('SELECT user_id FROM reminder_log').all();
    expect(results).toHaveLength(1);
  });
});

describe('reminder slots', () => {
  it('maps each configured cron to its own slot', () => {
    expect(slotForCron('0 11 * * *')).toBe('morning');
    expect(slotForCron('0 21 * * *')).toBe('evening');
  });

  it('falls back to morning and warns when a cron is not mapped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(slotForCron('30 4 * * *')).toBe('morning');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('30 4 * * *'));
  });

  it('names the later pass so it does not read as a repeat of the first', () => {
    const bills = [{ label: 'UTE $ 1.200 vence mañana', days: 1 }];
    expect(composeReminder(bills, 'morning')?.title).toBe('1 cuenta por vencer');
    expect(composeReminder(bills, 'evening')?.title).toBe('Recordatorio: 1 cuenta por vencer');
  });

  it('reports which slot a sweep ran as', async () => {
    expect((await runDailyReminders(env, 'evening')).slot).toBe('evening');
  });

  // The whole point of the slots: one notification a day is easy to miss, so a
  // bill that sits in the window gets at least two.
  it('notifies again in the evening after the morning pass', async () => {
    await registerToken(TOKEN_A);
    await setPrefs(USER_A, { reminder_days_before: 0 });
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(0), amount: 1200 });

    const sent = stubExpo();
    const morning = await runDailyReminders(env, 'morning');
    const evening = await runDailyReminders(env, 'evening');

    expect(morning.usersNotified).toBe(1);
    expect(evening.usersNotified).toBe(1);
    expect(evening.skippedAlreadySent).toBe(0);
    expect(sent).toHaveLength(2);
    expect(sent[0].title).toBe('1 cuenta por vencer');
    expect(sent[1].title).toBe('Recordatorio: 1 cuenta por vencer');
  });

  it('is still idempotent within a single slot', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    const sent = stubExpo();
    await runDailyReminders(env, 'evening');
    const again = await runDailyReminders(env, 'evening');

    expect(again.usersNotified).toBe(0);
    expect(again.skippedAlreadySent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('logs one row per slot per day', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    stubExpo();
    await runDailyReminders(env, 'morning');
    await runDailyReminders(env, 'evening');

    const { results } = await env.vence_db
      .prepare('SELECT slot FROM reminder_log WHERE user_id = ?1 ORDER BY slot')
      .bind(USER_A).all<{ slot: string }>();
    expect(results.map(r => r.slot)).toEqual(['evening', 'morning']);
  });

  it('releasing a failed slot leaves the slot that already went out alone', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    stubExpo();
    await runDailyReminders(env, 'morning');

    // Now the evening pass fails outright, so only its own claim is released.
    vi.restoreAllMocks();
    stubExpo(msgs => msgs.map(() => ({ status: 'error', message: 'ServiceUnavailable' })));
    const evening = await runDailyReminders(env, 'evening');
    expect(evening.usersNotified).toBe(0);

    const { results } = await env.vence_db
      .prepare('SELECT slot FROM reminder_log WHERE user_id = ?1')
      .bind(USER_A).all<{ slot: string }>();
    expect(results.map(r => r.slot)).toEqual(['morning']);
  });

  it('carries the slot in the push payload', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });

    const sent = stubExpo();
    await runDailyReminders(env, 'evening');
    expect(sent[0].data).toMatchObject({ kind: 'reminder', slot: 'evening' });
  });
});

describe('scheduled() handler', () => {
  it('runs the sweep when the cron fires', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });
    const sent = stubExpo();

    const controller = createScheduledController({ scheduledTime: new Date(), cron: '0 11 * * *' });
    const ctx = createExecutionContext();
    await worker.scheduled!(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(sent).toHaveLength(1);
  });

  it('routes the evening cron to the evening slot', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });
    const sent = stubExpo();

    const controller = createScheduledController({ scheduledTime: new Date(), cron: '0 21 * * *' });
    const ctx = createExecutionContext();
    await worker.scheduled!(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain('Recordatorio:');
  });

  it('does not throw when the sweep fails, so the cron is not retried forever', async () => {
    await registerToken(TOKEN_A);
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromLocalToday(1) });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));

    const controller = createScheduledController({ scheduledTime: new Date(), cron: '0 11 * * *' });
    const ctx = createExecutionContext();
    await expect(worker.scheduled!(controller, env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });
});
