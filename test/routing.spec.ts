import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applySchema, reset, seedUser, USER_A } from './helpers/db';
import { call, callJson } from './helpers/request';

beforeAll(applySchema);
beforeEach(async () => {
  await reset();
  await seedUser();
});

describe('router', () => {
  it('serves /health without a token', async () => {
    const { status, body } = await callJson('/health', { token: null });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it('tolerates a trailing slash', async () => {
    expect((await call('/health/', { token: null })).status).toBe(200);
  });

  it('returns 404 for an unknown path', async () => {
    const { status, body } = await callJson('/nope');
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Not found' });
  });

  it('returns 405 with an Allow header when the path exists but the method does not', async () => {
    const res = await call('/bills/some-id', { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')?.split(', ').sort()).toEqual(['DELETE', 'PATCH']);
  });

  it('answers preflight with 204 and CORS headers', async () => {
    const res = await call('/bills', { method: 'OPTIONS', token: null });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PATCH');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Filename');
  });

  it('rejects a protected route with no Authorization header', async () => {
    const { status, body } = await callJson('/bills', { token: null });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: expect.stringContaining('token') });
  });

  it('surfaces an AuthError status rather than a 500', async () => {
    expect((await call('/bills', { token: 'expired' })).status).toBe(401);
  });

  it('reports the caller identity on /me', async () => {
    const { status, body } = await callJson('/me');
    expect(status).toBe(200);
    expect(body).toEqual({ id: USER_A, email: 'a@vence.uy' });
  });
});

// These four routes were implemented but commented out of the route table. The
// registered /documents pattern is ^/documents/?$, so /documents/<id> matched
// nothing and the Documentos page's buttons 404'd.
describe('document routes are registered (regression: MM-04)', () => {
  it('resolves /documents/:id to the download handler, not a 404', async () => {
    const { status, body } = await callJson<{ error: string }>(
      '/documents/11111111-2222-3333-4444-555555555555'
    );
    // Both answers are 404, so the status can't tell them apart. The message
    // can: 'Documento no encontrado' means downloadDocument ran and found no
    // row, while the router's own miss would say 'Not found'.
    expect(status).toBe(404);
    expect(body.error).toBe('Documento no encontrado');
  });

  it('resolves DELETE /documents/:id', async () => {
    const { body } = await callJson<{ error: string }>(
      '/documents/11111111-2222-3333-4444-555555555555',
      { method: 'DELETE' }
    );
    expect(body.error).toBe('Documento no encontrado');
  });

  it('keeps GET /documents on the month listing', async () => {
    const { status, body } = await callJson<{ error: string }>('/documents');
    expect(status).toBe(400);
    expect(body.error).toBe('year y month son requeridos');
  });

  it('resolves the per-bill document routes with a billId param', async () => {
    const { status } = await callJson('/bills/some-bill/documents');
    expect(status).not.toBe(404);
  });
});

describe('bindings', () => {
  // The wrangler binding was `vence_bucket` while every call site read
  // env.BILLS_BUCKET, so document storage threw at runtime.
  it('exposes BILLS_BUCKET under the name the code uses (regression: MM-07)', async () => {
    const { env } = await import('cloudflare:test');
    expect(env.BILLS_BUCKET).toBeDefined();
    expect(typeof env.BILLS_BUCKET.put).toBe('function');
  });

  it('exposes vence_db', async () => {
    const { env } = await import('cloudflare:test');
    expect(env.vence_db).toBeDefined();
  });
});
