import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  applySchema, reset, seedUser, seedProvider, seedBill,
  isoDaysFromNow, USER_A, USER_B,
} from './helpers/db';
import { callJson } from './helpers/request';

beforeAll(applySchema);
beforeEach(async () => {
  await reset();
  await seedUser(USER_A);
  await seedUser(USER_B, 'b@vence.uy');
  await seedProvider({ id: 'p-1', userId: USER_A });
  await seedProvider({ id: 'p-b', userId: USER_B });
});

interface BillDto {
  id: string; providerId: string; amount: number; currency: string;
  dueDate: string; frequency: string; status: string;
  reference?: string; notes?: string; paidAt?: string; amountPaid?: number;
  createdAt: string; updatedAt: string;
}

const valid = {
  providerId: 'p-1', amount: 1200, currency: 'UYU',
  dueDate: '2026-11-10', frequency: 'mensual',
};

describe('POST /bills', () => {
  it('creates a bill with status pendiente', async () => {
    const { status, body } = await callJson<BillDto>('/bills', { method: 'POST', body: valid });
    expect(status).toBe(201);
    expect(body).toMatchObject({ providerId: 'p-1', amount: 1200, status: 'pendiente' });
  });

  it('persists reference, a field the UI only recently started sending', async () => {
    const { body } = await callJson<BillDto>('/bills', {
      method: 'POST', body: { ...valid, reference: 'Serie A 0001234' },
    });
    expect(body.reference).toBe('Serie A 0001234');
  });

  it('rejects a provider belonging to another user', async () => {
    const { status, body } = await callJson<{ error: string }>('/bills', {
      method: 'POST', body: { ...valid, providerId: 'p-b' },
    });
    expect(status).toBe(400);
    expect(body.error).toBe('Proveedor no encontrado');
  });

  it.each([
    ['amount zero', { amount: 0 }],
    ['amount negative', { amount: -5 }],
    ['amount not a number', { amount: '1200' }],
    ['amount Infinity', { amount: Infinity }],
    ['unknown currency', { currency: 'GBP' }],
    ['unknown frequency', { frequency: 'quincenal' }],
    ['dueDate wrong format', { dueDate: '10/11/2026' }],
    ['dueDate impossible', { dueDate: '2026-02-30' }],
    ['dueDate Feb 29 on a non-leap year', { dueDate: '2026-02-29' }],
    ['missing providerId', { providerId: '' }],
    ['reference too long', { reference: 'x'.repeat(201) }],
  ])('rejects %s with 400', async (_label, patch) => {
    const { status } = await callJson('/bills', { method: 'POST', body: { ...valid, ...patch } });
    expect(status).toBe(400);
  });

  it('accepts Feb 29 on a real leap year', async () => {
    const { status } = await callJson('/bills', {
      method: 'POST', body: { ...valid, dueDate: '2028-02-29' },
    });
    expect(status).toBe(201);
  });
});

describe('GET /bills', () => {
  it('derives vencida for an unpaid bill past its due date', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromNow(-3) });
    const { body } = await callJson<{ bills: BillDto[] }>('/bills');
    expect(body.bills[0].status).toBe('vencida');

    // The derivation is a read-time label, not a stored state.
    const row = await env.vence_db
      .prepare(`SELECT status FROM bills WHERE id = 'b-1'`)
      .first<{ status: string }>();
    expect(row?.status).toBe('pendiente');
  });

  it('leaves a future bill pendiente', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate: isoDaysFromNow(5) });
    const { body } = await callJson<{ bills: BillDto[] }>('/bills');
    expect(body.bills[0].status).toBe('pendiente');
  });

  it('never relabels a paid bill, even long past due', async () => {
    await seedBill({
      id: 'b-1', providerId: 'p-1',
      dueDate: isoDaysFromNow(-90), paidAt: '2026-08-01T12:00:00.000Z',
    });
    const { body } = await callJson<{ bills: BillDto[] }>('/bills');
    expect(body.bills[0].status).toBe('pagada');
  });

  it('scopes to the caller and sorts by due date', async () => {
    await seedBill({ id: 'b-late', providerId: 'p-1', dueDate: '2026-12-01' });
    await seedBill({ id: 'b-early', providerId: 'p-1', dueDate: '2026-11-01' });
    await seedBill({ id: 'b-other', providerId: 'p-b', userId: USER_B });

    const { body } = await callJson<{ bills: BillDto[] }>('/bills');
    expect(body.bills.map(b => b.id)).toEqual(['b-early', 'b-late']);
  });
});

describe('PATCH /bills/:id', () => {
  beforeEach(async () => { await seedBill({ id: 'b-1', providerId: 'p-1' }); });

  it('patches only what is sent', async () => {
    const { status, body } = await callJson<BillDto>('/bills/b-1', {
      method: 'PATCH', body: { amount: 1500 },
    });
    expect(status).toBe(200);
    expect(body.amount).toBe(1500);
    expect(body.currency).toBe('UYU');
  });

  it('refuses to move a bill onto another users provider', async () => {
    const { status } = await callJson('/bills/b-1', {
      method: 'PATCH', body: { providerId: 'p-b' },
    });
    expect(status).toBe(400);
  });

  it('clears reference and notes when sent empty strings', async () => {
    await callJson('/bills/b-1', { method: 'PATCH', body: { reference: 'R1', notes: 'N1' } });
    const { body } = await callJson<BillDto>('/bills/b-1', {
      method: 'PATCH', body: { reference: '', notes: '' },
    });
    expect(body.reference).toBeUndefined();
    expect(body.notes).toBeUndefined();
  });

  it('404s for another users bill', async () => {
    const { status } = await callJson('/bills/b-1', {
      method: 'PATCH', body: { amount: 1 }, token: 'user-b',
    });
    expect(status).toBe(404);
  });
});

describe('DELETE /bills/:id', () => {
  it('soft-deletes the bill and cascades to its documents', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-1' });
    await env.vence_db.prepare(
      `INSERT INTO documents (id, user_id, bill_id, r2_key, filename, size, content_type, uploaded_at)
       VALUES ('d-1', ?1, 'b-1', 'k1', 'f.pdf', 10, 'application/pdf', '2026-10-01T00:00:00Z')`
    ).bind(USER_A).run();

    const { status, body } = await callJson<{ documentsAffected: number }>('/bills/b-1', { method: 'DELETE' });
    expect(status).toBe(200);
    expect(body.documentsAffected).toBe(1);
  });

  it('404s on a second delete', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-1' });
    await callJson('/bills/b-1', { method: 'DELETE' });
    expect((await callJson('/bills/b-1', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('POST /bills/:id/pay', () => {
  it('marks paid with defaults of now and the full amount', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-1', amount: 1200, frequency: 'unica' });
    const { status, body } = await callJson<{ paid: BillDto; next: BillDto | null }>(
      '/bills/b-1/pay', { method: 'POST', body: {} }
    );
    expect(status).toBe(200);
    expect(body.paid.status).toBe('pagada');
    expect(body.paid.amountPaid).toBe(1200);
    expect(body.paid.paidAt).toBeTruthy();
    expect(body.next).toBeNull(); // 'unica' does not recur
  });

  it('honours an explicit paidAt and a partial amountPaid', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-1', amount: 1200, frequency: 'unica' });
    const { body } = await callJson<{ paid: BillDto }>('/bills/b-1/pay', {
      method: 'POST', body: { paidAt: '2026-10-05T10:00:00.000Z', amountPaid: 900 },
    });
    expect(body.paid.amountPaid).toBe(900);
    expect(body.paid.paidAt).toBe('2026-10-05T10:00:00.000Z');
  });

  it('409s when the bill is already paid', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-1', paidAt: '2026-10-01T00:00:00Z' });
    const { status, body } = await callJson<{ error: string }>('/bills/b-1/pay', { method: 'POST', body: {} });
    expect(status).toBe(409);
    expect(body.error).toBe('La cuenta ya está pagada');
  });

  it('404s for an unknown bill', async () => {
    expect((await callJson('/bills/nope/pay', { method: 'POST', body: {} })).status).toBe(404);
  });

  it.each([
    ['mensual', '2026-01-15', '2026-02-15'],
    ['bimestral', '2026-01-15', '2026-03-15'],
    ['trimestral', '2026-01-15', '2026-04-15'],
    ['semestral', '2026-01-15', '2026-07-15'],
    ['anual', '2026-01-15', '2027-01-15'],
    // Clamping: no Feb 31st, and 2026 is not a leap year.
    ['mensual', '2026-01-31', '2026-02-28'],
    ['mensual', '2028-01-31', '2028-02-29'],
    ['mensual', '2026-03-31', '2026-04-30'],
    // Year rollover.
    ['mensual', '2026-12-31', '2027-01-31'],
    ['anual', '2028-02-29', '2029-02-28'],
  ])('%s from %s creates the next occurrence on %s', async (frequency, dueDate, expected) => {
    await seedBill({ id: 'b-1', providerId: 'p-1', dueDate, frequency });
    const { body } = await callJson<{ next: BillDto | null }>('/bills/b-1/pay', {
      method: 'POST', body: {},
    });
    expect(body.next?.dueDate).toBe(expected);
  });

  it('carries provider, amount, currency, frequency and reference to the next occurrence but not notes', async () => {
    await callJson('/bills', {
      method: 'POST',
      body: { ...valid, reference: 'Serie A 1', notes: 'instancia puntual' },
    });
    const { body: list } = await callJson<{ bills: BillDto[] }>('/bills');
    const id = list.bills[0].id;

    const { body } = await callJson<{ next: BillDto | null }>(`/bills/${id}/pay`, {
      method: 'POST', body: {},
    });
    expect(body.next).toMatchObject({
      providerId: 'p-1', amount: 1200, currency: 'UYU',
      frequency: 'mensual', reference: 'Serie A 1', status: 'pendiente',
    });
    expect(body.next?.notes).toBeUndefined();
  });

  it('rejects an invalid amountPaid without marking the bill paid', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-1' });
    const { status } = await callJson('/bills/b-1/pay', { method: 'POST', body: { amountPaid: -1 } });
    expect(status).toBe(400);

    const row = await env.vence_db
      .prepare(`SELECT paid_at FROM bills WHERE id = 'b-1'`)
      .first<{ paid_at: string | null }>();
    expect(row?.paid_at).toBeNull();
  });

  it('treats a missing body as defaults rather than a 400', async () => {
    await seedBill({ id: 'b-1', providerId: 'p-1', frequency: 'unica' });
    const { status } = await callJson('/bills/b-1/pay', { method: 'POST' });
    expect(status).toBe(200);
  });
});
