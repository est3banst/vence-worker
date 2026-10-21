import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applySchema, reset, seedUser, USER_A, USER_B } from './helpers/db';
import { callJson } from './helpers/request';

beforeAll(applySchema);
beforeEach(async () => {
  await reset();
  await seedUser(USER_A);
  await seedUser(USER_B, 'b@vence.uy');
});
afterEach(() => { vi.restoreAllMocks(); });

const TOKEN = 'ExponentPushToken[AAAAAAAAAAAAAAAAAAAAAA]';

/**
 * Stands in for Expo's push service so no test reaches the network.
 *
 * Expo has two endpoints with different response shapes: /push/send answers an
 * array of tickets, /push/getReceipts a map keyed by ticket id. `receipts`
 * left undefined means every accepted ticket comes back delivered, which is
 * what the happy path looks like.
 */
function stubExpo(
  tickets: unknown[],
  receipts?: Record<string, unknown>,
  status = 200,
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (!url.includes('exp.host')) throw new Error(`unexpected fetch to ${url}`);

    const body = url.includes('getReceipts')
      ? {
          data: receipts ?? Object.fromEntries(
            tickets
              .filter((t): t is { id: string } => typeof (t as { id?: string }).id === 'string')
              .map(t => [t.id, { status: 'ok' }])
          ),
        }
      : { data: tickets };

    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('GET /push/tokens', () => {
  it('is empty before anything registers', async () => {
    const { status, body } = await callJson('/push/tokens');
    expect(status).toBe(200);
    expect(body).toEqual({ devices: [] });
  });

  it('lists the caller devices', async () => {
    await callJson('/push/tokens', {
      method: 'POST', body: { token: TOKEN, platform: 'android', deviceName: 'Pixel 8' },
    });
    const { status, body } = await callJson('/push/tokens');
    expect(status).toBe(200);
    const { devices } = body as { devices: { token: string; platform: string; deviceName: string }[] };
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ token: TOKEN, platform: 'android', deviceName: 'Pixel 8' });
  });

  it('does not leak another account devices', async () => {
    await callJson('/push/tokens', {
      method: 'POST', body: { token: TOKEN, platform: 'android' },
    });
    const { body } = await callJson('/push/tokens', { token: 'user-b' });
    expect(body).toEqual({ devices: [] });
  });

  it('hides tokens Expo has rejected', async () => {
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });
    await env.vence_db.prepare(
      'UPDATE push_tokens SET disabled_at = unixepoch() WHERE token = ?1'
    ).bind(TOKEN).run();

    const { body } = await callJson('/push/tokens');
    expect(body).toEqual({ devices: [] });
  });

  it('requires auth', async () => {
    const { status } = await callJson('/push/tokens', { token: null });
    expect(status).toBe(401);
  });
});

describe('POST /push/tokens', () => {
  it('registers a device', async () => {
    const { status, body } = await callJson('/push/tokens', {
      method: 'POST', body: { token: TOKEN, platform: 'android', deviceName: 'Pixel 8' },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ registered: true });

    const row = await env.vence_db
      .prepare('SELECT user_id, platform, device_name, disabled_at FROM push_tokens WHERE token = ?1')
      .bind(TOKEN).first<{ user_id: string; platform: string; device_name: string; disabled_at: number | null }>();
    expect(row).toMatchObject({ user_id: USER_A, platform: 'android', device_name: 'Pixel 8', disabled_at: null });
  });

  it('is idempotent: re-registering refreshes rather than duplicating', async () => {
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });

    const { results } = await env.vence_db
      .prepare('SELECT token FROM push_tokens').all();
    expect(results).toHaveLength(1);
  });

  it('re-enables a token that Expo had previously rejected', async () => {
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });
    await env.vence_db.prepare(
      'UPDATE push_tokens SET disabled_at = unixepoch() WHERE token = ?1'
    ).bind(TOKEN).run();

    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });
    const row = await env.vence_db
      .prepare('SELECT disabled_at FROM push_tokens WHERE token = ?1')
      .bind(TOKEN).first<{ disabled_at: number | null }>();
    expect(row?.disabled_at).toBeNull();
  });

  it('moves a shared device to whoever registered last', async () => {
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });
    await callJson('/push/tokens', {
      method: 'POST', body: { token: TOKEN, platform: 'android' }, token: 'user-b',
    });
    const row = await env.vence_db
      .prepare('SELECT user_id FROM push_tokens WHERE token = ?1')
      .bind(TOKEN).first<{ user_id: string }>();
    expect(row?.user_id).toBe(USER_B);
  });

  it('keeps an existing device name when a later call omits it', async () => {
    await callJson('/push/tokens', {
      method: 'POST', body: { token: TOKEN, platform: 'android', deviceName: 'Pixel 8' },
    });
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });
    const row = await env.vence_db
      .prepare('SELECT device_name FROM push_tokens WHERE token = ?1')
      .bind(TOKEN).first<{ device_name: string | null }>();
    expect(row?.device_name).toBe('Pixel 8');
  });

  it.each([
    ['not an Expo token', 'abc123'],
    ['empty', ''],
    ['nearly right', 'ExponentPushToken[]'],
    ['injection-ish', "ExponentPushToken[a'); DROP TABLE users;--]"],
  ])('rejects a token that is %s', async (_label, token) => {
    const { status, body } = await callJson<{ error: string }>('/push/tokens', {
      method: 'POST', body: { token, platform: 'android' },
    });
    expect(status).toBe(400);
    expect(body.error).toBe('token de push inválido');
  });

  it('accepts the ExpoPushToken spelling too', async () => {
    const { status } = await callJson('/push/tokens', {
      method: 'POST', body: { token: 'ExpoPushToken[BBBBBBBBBBBBBBBBBBBBBB]', platform: 'ios' },
    });
    expect(status).toBe(200);
  });

  it('rejects an unknown platform', async () => {
    const { status, body } = await callJson<{ error: string }>('/push/tokens', {
      method: 'POST', body: { token: TOKEN, platform: 'windows' },
    });
    expect(status).toBe(400);
    expect(body.error).toContain('platform inválida');
  });
});

describe('DELETE /push/tokens', () => {
  it('removes only the callers registration', async () => {
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });

    // B cannot delete A's token.
    await callJson('/push/tokens', { method: 'DELETE', body: { token: TOKEN }, token: 'user-b' });
    let { results } = await env.vence_db.prepare('SELECT token FROM push_tokens').all();
    expect(results).toHaveLength(1);

    await callJson('/push/tokens', { method: 'DELETE', body: { token: TOKEN } });
    ({ results } = await env.vence_db.prepare('SELECT token FROM push_tokens').all());
    expect(results).toHaveLength(0);
  });

  it('requires a token in the body', async () => {
    const { status } = await callJson('/push/tokens', { method: 'DELETE', body: {} });
    expect(status).toBe(400);
  });

  // A client that reinstalled holds a different token from the one on file, so
  // its delete matches nothing. Answering `deleted: true` there is what let the
  // app report a device switched off while the server still held it.
  it('reports deleted: false when no row matched', async () => {
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });

    const stale = 'ExponentPushToken[ZZZZZZZZZZZZZZZZZZZZZZ]';
    const miss = await callJson<{ deleted: boolean }>(
      '/push/tokens', { method: 'DELETE', body: { token: stale } }
    );
    expect(miss.status).toBe(200);
    expect(miss.body.deleted).toBe(false);

    const hit = await callJson<{ deleted: boolean }>(
      '/push/tokens', { method: 'DELETE', body: { token: TOKEN } }
    );
    expect(hit.body.deleted).toBe(true);
  });

  it('reports deleted: false when another account owns the token', async () => {
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });
    const { body } = await callJson<{ deleted: boolean }>(
      '/push/tokens', { method: 'DELETE', body: { token: TOKEN }, token: 'user-b' }
    );
    expect(body.deleted).toBe(false);
  });
});

describe('POST /push/test', () => {
  it('404s when the user has no registered device', async () => {
    const { status, body } = await callJson<{ error: string }>('/push/test', { method: 'POST' });
    expect(status).toBe(404);
    expect(body.error).toBe('No tenés dispositivos registrados');
  });

  it('sends to each registered device and reports the count', async () => {
    const spy = stubExpo([{ status: 'ok', id: 't1' }]);
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });

    const { status, body } = await callJson<{
      devices: number; sent: number; delivered: number; pending: number; errors: string[];
    }>('/push/test', { method: 'POST' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ devices: 1, sent: 1, delivered: 1, pending: 0, errors: [] });

    const [, init] = spy.mock.calls[0];
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload[0]).toMatchObject({ to: TOKEN, channelId: 'reminders' });
  });

  it('disables a token Expo reports as DeviceNotRegistered', async () => {
    stubExpo([{ status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }]);
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });

    const { body } = await callJson<{ sent: number; disabled: number }>('/push/test', { method: 'POST' });
    expect(body).toMatchObject({ sent: 0, disabled: 1 });

    const row = await env.vence_db
      .prepare('SELECT disabled_at FROM push_tokens WHERE token = ?1')
      .bind(TOKEN).first<{ disabled_at: number | null }>();
    expect(row?.disabled_at).not.toBeNull();
  });

  it('surfaces a non-DeviceNotRegistered error without disabling the token', async () => {
    stubExpo([{ status: 'error', message: 'MismatchSenderId', details: { error: 'MismatchSenderId' } }]);
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });

    const { body } = await callJson<{ sent: number; disabled: number; errors: string[] }>(
      '/push/test', { method: 'POST' }
    );
    expect(body.sent).toBe(0);
    expect(body.disabled).toBe(0);
    expect(body.errors).toContain('MismatchSenderId');
  });

  // The failure this endpoint exists to catch, and the one it used to miss:
  // Expo accepts the message, then the transport rejects it. Only the receipt
  // says so.
  it('reports a token the receipt rejects, and retires it', async () => {
    stubExpo(
      [{ status: 'ok', id: 't1' }],
      { t1: {
        status: 'error',
        message: 'The recipient device is not registered with FCM.',
        details: { error: 'DeviceNotRegistered' },
      } },
    );
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });

    const { body } = await callJson<{
      sent: number; delivered: number; disabled: number; errors: string[];
    }>('/push/test', { method: 'POST' });

    // Expo took it, the device never got it. Saying "sent 1" alone is the lie.
    expect(body.sent).toBe(1);
    expect(body.delivered).toBe(0);
    expect(body.disabled).toBe(1);
    expect(body.errors.join(' ')).toContain('not registered with FCM');

    const row = await env.vence_db
      .prepare('SELECT disabled_at FROM push_tokens WHERE token = ?1')
      .bind(TOKEN).first<{ disabled_at: number | null }>();
    expect(row?.disabled_at).not.toBeNull();
  });

  it('leaves the token alone when a receipt fails for a transient reason', async () => {
    stubExpo(
      [{ status: 'ok', id: 't1' }],
      { t1: { status: 'error', message: 'MessageRateExceeded', details: { error: 'MessageRateExceeded' } } },
    );
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });

    const { body } = await callJson<{ delivered: number; disabled: number; errors: string[] }>(
      '/push/test', { method: 'POST' }
    );
    expect(body.delivered).toBe(0);
    expect(body.disabled).toBe(0);
    expect(body.errors.join(' ')).toContain('MessageRateExceeded');

    const row = await env.vence_db
      .prepare('SELECT disabled_at FROM push_tokens WHERE token = ?1')
      .bind(TOKEN).first<{ disabled_at: number | null }>();
    expect(row?.disabled_at).toBeNull();
  });

  it('reports an undecided receipt as pending rather than as a failure', async () => {
    stubExpo([{ status: 'ok', id: 't1' }], {});
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });

    const { body } = await callJson<{
      sent: number; delivered: number; pending: number; disabled: number;
    }>('/push/test', { method: 'POST' });
    expect(body).toMatchObject({ sent: 1, delivered: 0, pending: 1, disabled: 0 });
  });

  it('skips a disabled device', async () => {
    await callJson('/push/tokens', { method: 'POST', body: { token: TOKEN, platform: 'android' } });
    await env.vence_db.prepare(
      'UPDATE push_tokens SET disabled_at = unixepoch() WHERE token = ?1'
    ).bind(TOKEN).run();

    const { status } = await callJson('/push/test', { method: 'POST' });
    expect(status).toBe(404);
  });
});
