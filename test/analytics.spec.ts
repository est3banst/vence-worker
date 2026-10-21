import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, reset, seedUser, seedProvider, seedBill, isoDaysFromNow, USER_A, USER_B } from './helpers/db';
import { callJson } from './helpers/request';

beforeAll(applySchema);
beforeEach(async () => {
  await reset();
  await seedUser(USER_A);
  await seedUser(USER_B, 'b@vence.uy');
  await seedProvider({ id: 'p-serv', category: 'servicios', name: 'UTE' });
  await seedProvider({ id: 'p-net', category: 'internet', name: 'Antel' });
});

/** paid_at inside the current month, so the summary/by-category windows catch it. */
async function markPaid(id: string, amountPaid: number) {
  await env.vence_db.prepare(
    `UPDATE bills SET status='pagada', paid_at=?2, amount_paid=?3 WHERE id=?1`
  ).bind(id, new Date().toISOString(), amountPaid).run();
}

interface CurrencyTotal { currency: string; count: number; amount: number }

describe('GET /analytics/summary', () => {
  it('splits unpaid bills into overdue and pending by currency', async () => {
    await seedBill({ id: 'b-od', providerId: 'p-serv', dueDate: isoDaysFromNow(-4), amount: 500 });
    await seedBill({ id: 'b-pd', providerId: 'p-serv', dueDate: isoDaysFromNow(+6), amount: 700 });
    await seedBill({ id: 'b-usd', providerId: 'p-serv', dueDate: isoDaysFromNow(+6), amount: 30, currency: 'USD' });

    const { status, body } = await callJson<{
      period: { start: string; end: string };
      pending: CurrencyTotal[]; overdue: CurrencyTotal[]; paidInPeriod: CurrencyTotal[];
    }>('/analytics/summary');

    expect(status).toBe(200);
    expect(body.overdue).toEqual([{ currency: 'UYU', count: 1, amount: 500 }]);
    expect(body.pending).toEqual(
      expect.arrayContaining([
        { currency: 'UYU', count: 1, amount: 700 },
        { currency: 'USD', count: 1, amount: 30 },
      ])
    );
    expect(body.period.start).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('counts paid bills by amount_paid, falling back to amount', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-serv', amount: 1000 });
    await markPaid('b-1', 850);
    await seedBill({ id: 'b-2', providerId: 'p-serv', amount: 200 });
    await env.vence_db.prepare(
      `UPDATE bills SET status='pagada', paid_at=?1 WHERE id='b-2'`
    ).bind(new Date().toISOString()).run(); // no amount_paid

    const { body } = await callJson<{ paidInPeriod: CurrencyTotal[] }>('/analytics/summary');
    expect(body.paidInPeriod).toEqual([{ currency: 'UYU', count: 2, amount: 1050 }]);
  });

  it('returns empty buckets rather than erroring with no data', async () => {
    const { status, body } = await callJson<{ pending: unknown[]; overdue: unknown[] }>('/analytics/summary');
    expect(status).toBe(200);
    expect(body.pending).toEqual([]);
    expect(body.overdue).toEqual([]);
  });

  it('ignores other users', async () => {
    await seedProvider({ id: 'p-x', userId: USER_B });
    await seedBill({ id: 'b-x', providerId: 'p-x', userId: USER_B, dueDate: isoDaysFromNow(-1) });
    const { body } = await callJson<{ overdue: unknown[] }>('/analytics/summary');
    expect(body.overdue).toEqual([]);
  });
});

// handlers/analytics.ts shipped with no imports for `json` or `AuthContext`:
// 6 tsc errors, and a ReferenceError at runtime that the router turned into a
// 500. Both endpoints were dead.
describe('analytics handlers run at all (regression: MM-01)', () => {
  it('GET /analytics/monthly returns 200, not 500', async () => {
    const { status, body } = await callJson<{ months: { yearMonth: string; totals: unknown[] }[] }>(
      '/analytics/monthly'
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.months)).toBe(true);
  });

  it('GET /analytics/by-category returns 200, not 500', async () => {
    const { status, body } = await callJson<{ categories: unknown[] }>('/analytics/by-category');
    expect(status).toBe(200);
    expect(Array.isArray(body.categories)).toBe(true);
  });
});

describe('GET /analytics/monthly', () => {
  it('zero-fills the window so the chart has a continuous axis', async () => {
    const { body } = await callJson<{ months: { yearMonth: string; totals: unknown[] }[] }>(
      '/analytics/monthly?months=6'
    );
    expect(body.months).toHaveLength(6);
    expect(body.months.every(m => /^\d{4}-\d{2}$/.test(m.yearMonth))).toBe(true);
    // Ascending, ending on the current month.
    const sorted = [...body.months].map(m => m.yearMonth).sort();
    expect(body.months.map(m => m.yearMonth)).toEqual(sorted);
    expect(body.months.at(-1)?.yearMonth).toBe(new Date().toISOString().slice(0, 7));
  });

  it('defaults to 12 months and clamps an out-of-range request', async () => {
    for (const q of ['', '?months=0', '?months=99', '?months=abc']) {
      const { body } = await callJson<{ months: unknown[] }>(`/analytics/monthly${q}`);
      expect(body.months, `months${q}`).toHaveLength(12);
    }
  });

  it('places a payment in the current month bucket', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-serv', amount: 400 });
    await markPaid('b-1', 400);

    const { body } = await callJson<{ months: { yearMonth: string; totals: { currency: string; amount: number }[] }[] }>(
      '/analytics/monthly?months=2'
    );
    const current = body.months.at(-1)!;
    expect(current.totals).toEqual([{ currency: 'UYU', amount: 400, count: 1 }]);
  });
});

describe('GET /analytics/by-category', () => {
  it('groups by the provider category, descending by amount', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-serv', amount: 100 });
    await seedBill({ id: 'b-2', providerId: 'p-net', amount: 900 });
    await markPaid('b-1', 100);
    await markPaid('b-2', 900);

    const { body } = await callJson<{ categories: { category: string; totals: { amount: number }[] }[] }>(
      '/analytics/by-category'
    );
    expect(body.categories.map(c => c.category)).toEqual(['internet', 'servicios']);
  });

  // The handler coalesces a null category to 'otro' for the LEFT JOIN. That
  // branch is unreachable while foreign keys are enforced — a bill cannot point
  // at a provider that isn't there — so what's worth asserting is the guarantee
  // that makes it unreachable, not the dead branch.
  it('cannot orphan a bill from its provider', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-serv', amount: 50 });
    await expect(
      env.vence_db.prepare(`UPDATE bills SET provider_id='ghost' WHERE id='b-1'`).run()
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      env.vence_db.prepare(`DELETE FROM providers WHERE id='p-serv'`).run()
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('excludes unpaid bills entirely', async () => {
    await seedBill({ id: 'b-unpaid', providerId: 'p-serv', amount: 999 });
    const { body } = await callJson<{ categories: unknown[] }>('/analytics/by-category');
    expect(body.categories).toEqual([]);
  });

  it.each([
    ['?year=1999', 'year inválido'],
    ['?year=2101', 'year inválido'],
    ['?month=0', 'month inválido'],
    ['?month=13', 'month inválido'],
  ])('rejects %s', async (query, message) => {
    const { status, body } = await callJson<{ error: string }>(`/analytics/by-category${query}`);
    expect(status).toBe(400);
    expect(body.error).toBe(message);
  });

  it('accepts an explicit in-range year and month', async () => {
    const { status } = await callJson('/analytics/by-category?year=2026&month=9');
    expect(status).toBe(200);
  });
});
