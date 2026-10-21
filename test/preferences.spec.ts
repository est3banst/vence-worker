import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema, reset, seedUser, USER_A } from './helpers/db';
import { callJson } from './helpers/request';

beforeAll(applySchema);
beforeEach(async () => { await reset(); await seedUser(USER_A); });

interface PrefsDto {
  defaultCurrency: string; timezone: string; reminderDaysBefore: number;
  notifyByEmail: boolean; notifyByWebPush: boolean; notifyByPush: boolean;
  updatedAt: string | null;
}

describe('GET /preferences', () => {
  it('returns Uruguay-shaped defaults with a null updatedAt when no row exists', async () => {
    const { status, body } = await callJson<PrefsDto>('/preferences');
    expect(status).toBe(200);
    expect(body).toEqual({
      defaultCurrency: 'UYU',
      timezone: 'America/Montevideo',
      reminderDaysBefore: 3,
      notifyByEmail: true,
      notifyByWebPush: true,
      notifyByPush: true,
      updatedAt: null,
    });
  });
});

describe('PATCH /preferences', () => {
  it('creates the row on first write and returns a real updatedAt', async () => {
    const { status, body } = await callJson<PrefsDto>('/preferences', {
      method: 'PATCH', body: { reminderDaysBefore: 7 },
    });
    expect(status).toBe(200);
    expect(body.reminderDaysBefore).toBe(7);
    expect(body.updatedAt).not.toBeNull();
  });

  it('keeps unsent fields on a later patch', async () => {
    await callJson('/preferences', { method: 'PATCH', body: { reminderDaysBefore: 7, defaultCurrency: 'USD' } });
    const { body } = await callJson<PrefsDto>('/preferences', {
      method: 'PATCH', body: { notifyByEmail: false },
    });
    expect(body).toMatchObject({ reminderDaysBefore: 7, defaultCurrency: 'USD', notifyByEmail: false });
  });

  // notify_by_push was added for mobile reminders; it has to survive the round
  // trip or the cron can't tell who muted push.
  it('round-trips notifyByPush independently of notifyByWebPush', async () => {
    const { body } = await callJson<PrefsDto>('/preferences', {
      method: 'PATCH', body: { notifyByPush: false, notifyByWebPush: true },
    });
    expect(body.notifyByPush).toBe(false);
    expect(body.notifyByWebPush).toBe(true);

    const { body: reread } = await callJson<PrefsDto>('/preferences');
    expect(reread.notifyByPush).toBe(false);
  });

  it.each([0, 1, 30])('accepts reminderDaysBefore = %i', async days => {
    const { status, body } = await callJson<PrefsDto>('/preferences', {
      method: 'PATCH', body: { reminderDaysBefore: days },
    });
    expect(status).toBe(200);
    expect(body.reminderDaysBefore).toBe(days);
  });

  it.each([
    ['reminderDaysBefore negative', { reminderDaysBefore: -1 }],
    ['reminderDaysBefore over 30', { reminderDaysBefore: 31 }],
    ['reminderDaysBefore fractional', { reminderDaysBefore: 2.5 }],
    ['unknown currency', { defaultCurrency: 'GBP' }],
    ['timezone too long', { timezone: 'x'.repeat(65) }],
    ['notifyByEmail not boolean', { notifyByEmail: 'yes' }],
    ['notifyByPush not boolean', { notifyByPush: 1 }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await callJson('/preferences', { method: 'PATCH', body })).status).toBe(400);
  });

  it('leaves the stored row untouched when validation fails', async () => {
    await callJson('/preferences', { method: 'PATCH', body: { reminderDaysBefore: 5 } });
    await callJson('/preferences', { method: 'PATCH', body: { reminderDaysBefore: 99 } });
    const { body } = await callJson<PrefsDto>('/preferences');
    expect(body.reminderDaysBefore).toBe(5);
  });

  it('isolates preferences per user', async () => {
    await callJson('/preferences', { method: 'PATCH', body: { reminderDaysBefore: 10 } });
    const { body } = await callJson<PrefsDto>('/preferences', { token: 'user-b' });
    expect(body.reminderDaysBefore).toBe(3); // B still sees defaults
  });
});

// subscriptions.tier was CHECK IN ('free','pro') while the app offers a
// 'personal' tier, so createCheckout's INSERT failed after the Mercado Pago
// preapproval had already been created.
describe('subscriptions', () => {
  it('reports the free tier when the user has no subscription row', async () => {
    const { status, body } = await callJson<{ tier: string; status: string }>('/subscriptions/me');
    expect(status).toBe(200);
    expect(body).toEqual({ tier: 'free', status: 'active' });
  });

  it.each(['free', 'personal', 'pro'])(
    'accepts the %s tier at the DB level (regression: MM-11)',
    async tier => {
      const { env } = await import('cloudflare:test');
      await expect(
        env.vence_db.prepare(
          `INSERT INTO subscriptions (id, user_id, tier, status) VALUES (?1, ?2, ?3, 'active')`
        ).bind(`s-${tier}`, USER_A, tier).run()
      ).resolves.toBeTruthy();
      await env.vence_db.prepare(`DELETE FROM subscriptions WHERE id = ?1`).bind(`s-${tier}`).run();
    }
  );

  it('still rejects a tier nobody offers', async () => {
    const { env } = await import('cloudflare:test');
    await expect(
      env.vence_db.prepare(
        `INSERT INTO subscriptions (id, user_id, tier, status) VALUES ('s-x', ?1, 'enterprise', 'active')`
      ).bind(USER_A).run()
    ).rejects.toThrow(/CHECK constraint/);
  });

  it('404s on cancel when there is nothing active', async () => {
    const { status } = await callJson('/subscriptions/cancel', { method: 'POST' });
    expect(status).toBe(404);
  });
});
