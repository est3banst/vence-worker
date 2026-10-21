import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema, reset, seedUser, seedProvider, seedBill, USER_A, USER_B } from './helpers/db';
import { callJson } from './helpers/request';
import { env } from 'cloudflare:test';

beforeAll(applySchema);
beforeEach(async () => {
  await reset();
  await seedUser(USER_A);
  await seedUser(USER_B, 'b@vence.uy');
});

interface ProviderDto {
  id: string; name: string; category: string;
  notes?: string; createdAt: string; updatedAt: string;
}

describe('POST /providers', () => {
  it('creates a provider and returns 201 with the DTO shape', async () => {
    const { status, body } = await callJson<ProviderDto>('/providers', {
      method: 'POST',
      body: { name: 'UTE', category: 'servicios', notes: 'Cuenta 12345' },
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: 'UTE', category: 'servicios', notes: 'Cuenta 12345' });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(body.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('trims the name', async () => {
    const { body } = await callJson<ProviderDto>('/providers', {
      method: 'POST', body: { name: '  Antel  ', category: 'internet' },
    });
    expect(body.name).toBe('Antel');
  });

  // The frontend has always offered these two; the worker and the DB CHECK
  // both rejected them, so picking either returned 400.
  it.each(['seguro', 'patente'])(
    'accepts the %s category (regression: MM-08)',
    async category => {
      const { status, body } = await callJson<ProviderDto>('/providers', {
        method: 'POST', body: { name: 'Seguro del auto', category },
      });
      expect(status).toBe(201);
      expect(body.category).toBe(category);
    }
  );

  it('accepts every category the frontend offers', async () => {
    const all = [
      'servicios', 'internet', 'suscripcion', 'profesional', 'impuesto',
      'alquiler', 'tarjeta', 'seguro', 'patente', 'otro',
    ];
    for (const category of all) {
      const { status } = await callJson('/providers', {
        method: 'POST', body: { name: `P-${category}`, category },
      });
      expect(status, `category ${category}`).toBe(201);
    }
  });

  it('rejects an unknown category with the valid list', async () => {
    const { status, body } = await callJson<{ error: string }>('/providers', {
      method: 'POST', body: { name: 'X', category: 'nope' },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('category inválida');
    expect(body.error).toContain('seguro');
  });

  it.each([
    ['missing name', { category: 'otro' }],
    ['empty name', { name: '   ', category: 'otro' }],
    ['name over 200 chars', { name: 'x'.repeat(201), category: 'otro' }],
    ['notes over 2000 chars', { name: 'X', category: 'otro', notes: 'x'.repeat(2001) }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await callJson('/providers', { method: 'POST', body })).status).toBe(400);
  });

  it('rejects a non-JSON body', async () => {
    const { status } = await callJson('/providers', {
      method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' },
    });
    expect(status).toBe(400);
  });

  it('stores an empty notes string as null, matching createBill', async () => {
    const { body } = await callJson<ProviderDto>('/providers', {
      method: 'POST', body: { name: 'X', category: 'otro', notes: '' },
    });
    expect(body.notes).toBeUndefined();
  });
});

describe('GET /providers', () => {
  it('returns only the callers providers', async () => {
    await seedProvider({ id: 'p-a', userId: USER_A, name: 'Mine' });
    await seedProvider({ id: 'p-b', userId: USER_B, name: 'Theirs' });

    const { body } = await callJson<{ providers: ProviderDto[] }>('/providers');
    expect(body.providers.map(p => p.name)).toEqual(['Mine']);
  });

  it('hides soft-deleted providers', async () => {
    await seedProvider({ id: 'p-1', name: 'Gone' });
    await env.vence_db.prepare(
      `UPDATE providers SET deleted_at = unixepoch() WHERE id = 'p-1'`
    ).run();

    const { body } = await callJson<{ providers: ProviderDto[] }>('/providers');
    expect(body.providers).toEqual([]);
  });

  it('sorts case-insensitively by name', async () => {
    await seedProvider({ id: 'p1', name: 'zeta' });
    await seedProvider({ id: 'p2', name: 'Alpha' });
    await seedProvider({ id: 'p3', name: 'beta' });

    const { body } = await callJson<{ providers: ProviderDto[] }>('/providers');
    expect(body.providers.map(p => p.name)).toEqual(['Alpha', 'beta', 'zeta']);
  });
});

describe('PATCH /providers/:id', () => {
  beforeEach(async () => { await seedProvider({ id: 'p-1', name: 'UTE', category: 'servicios' }); });

  it('patches only the fields supplied', async () => {
    const { status, body } = await callJson<ProviderDto>('/providers/p-1', {
      method: 'PATCH', body: { name: 'UTE Montevideo' },
    });
    expect(status).toBe(200);
    expect(body.name).toBe('UTE Montevideo');
    expect(body.category).toBe('servicios');
  });

  it('clears notes when sent an empty string', async () => {
    await callJson('/providers/p-1', { method: 'PATCH', body: { notes: 'temporary' } });
    const { body } = await callJson<ProviderDto>('/providers/p-1', {
      method: 'PATCH', body: { notes: '' },
    });
    expect(body.notes).toBeUndefined();
  });

  it('404s for another users provider', async () => {
    const { status } = await callJson('/providers/p-1', {
      method: 'PATCH', body: { name: 'Hijacked' }, token: 'user-b',
    });
    expect(status).toBe(404);
  });

  it('404s for an unknown id', async () => {
    expect((await callJson('/providers/nope', { method: 'PATCH', body: { name: 'X' } })).status).toBe(404);
  });
});

describe('DELETE /providers/:id', () => {
  it('soft-deletes the provider and cascades to its bills', async () => {
    await seedProvider({ id: 'p-1' });
    await seedBill({ id: 'b-1', providerId: 'p-1' });
    await seedBill({ id: 'b-2', providerId: 'p-1' });

    const { status, body } = await callJson<{ deleted: boolean; billsAffected: number }>(
      '/providers/p-1', { method: 'DELETE' }
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ deleted: true, billsAffected: 2 });

    // Soft delete: rows stay, flagged.
    const rows = await env.vence_db
      .prepare(`SELECT deleted_at FROM bills WHERE provider_id = 'p-1'`)
      .all<{ deleted_at: number | null }>();
    expect(rows.results?.every(r => r.deleted_at !== null)).toBe(true);
  });

  it('reports 0 bills affected when the provider has none', async () => {
    await seedProvider({ id: 'p-1' });
    const { body } = await callJson<{ billsAffected: number }>('/providers/p-1', { method: 'DELETE' });
    expect(body.billsAffected).toBe(0);
  });

  it('404s on a second delete', async () => {
    await seedProvider({ id: 'p-1' });
    await callJson('/providers/p-1', { method: 'DELETE' });
    expect((await callJson('/providers/p-1', { method: 'DELETE' })).status).toBe(404);
  });

  it('does not touch another users bills', async () => {
    await seedProvider({ id: 'p-a', userId: USER_A });
    await seedProvider({ id: 'p-b', userId: USER_B });
    await seedBill({ id: 'b-b', providerId: 'p-b', userId: USER_B });

    await callJson('/providers/p-a', { method: 'DELETE' });
    const row = await env.vence_db
      .prepare(`SELECT deleted_at FROM bills WHERE id = 'b-b'`)
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).toBeNull();
  });
});
