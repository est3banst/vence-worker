import type { Env } from '../env';
import type { AuthContext } from '../auth';
import { json } from '../helpers/helpers';
import { sendPush } from '../notifications/expo';

const VALID_PLATFORMS = ['ios', 'android'] as const;

// Expo's token format. Validated so we never store something the push service
// will reject for every future send.
const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

/**
 * GET /push/tokens — the caller's registered devices.
 *
 * Registration lives on the server, so the client cannot infer it from the OS
 * permission alone: a device can hold the permission and still have no token
 * here if the Expo token request failed. The UI asks this instead of guessing.
 */
export async function listPushTokens(
  _req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const rows = await env.vence_db.prepare(
    `SELECT token, platform, device_name, created_at, last_seen_at
       FROM push_tokens
      WHERE user_id = ?1 AND disabled_at IS NULL
      ORDER BY last_seen_at DESC`
  ).bind(auth.sub).all<{
    token: string;
    platform: string;
    device_name: string | null;
    created_at: number;
    last_seen_at: number;
  }>();

  return json({
    devices: (rows.results ?? []).map(r => ({
      token: r.token,
      platform: r.platform,
      deviceName: r.device_name,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    })),
  }, 200, cors);
}

/** POST /push/tokens — register (or refresh) this device for the caller. */
export async function registerPushToken(
  req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Body inválido' }, 400, cors);

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!TOKEN_RE.test(token)) {
    return json({ error: 'token de push inválido' }, 400, cors);
  }

  const platform = typeof body.platform === 'string' ? body.platform : '';
  if (!(VALID_PLATFORMS as readonly string[]).includes(platform)) {
    return json({ error: `platform inválida (valores: ${VALID_PLATFORMS.join(', ')})` }, 400, cors);
  }

  const deviceName =
    typeof body.deviceName === 'string' && body.deviceName.trim()
      ? body.deviceName.trim().slice(0, 120)
      : null;

  // A token can move between accounts if two people share a device, so
  // user_id is part of the update rather than fixed at insert.
  await env.vence_db.prepare(
    `INSERT INTO push_tokens (token, user_id, platform, device_name, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())
     ON CONFLICT(token) DO UPDATE SET
       user_id      = excluded.user_id,
       platform     = excluded.platform,
       device_name  = COALESCE(excluded.device_name, push_tokens.device_name),
       last_seen_at = unixepoch(),
       disabled_at  = NULL`
  ).bind(token, auth.sub, platform, deviceName).run();

  return json({ registered: true }, 200, cors);
}

/** DELETE /push/tokens — unregister this device (sign-out, or toggle off). */
export async function deletePushToken(
  req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { token?: string } | null;
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token) return json({ error: 'token requerido' }, 400, cors);

  await env.vence_db.prepare(
    `DELETE FROM push_tokens WHERE token = ?1 AND user_id = ?2`
  ).bind(token, auth.sub).run();

  return json({ deleted: true }, 200, cors);
}

/**
 * POST /push/test — send a push to the caller's own devices.
 * Exists so the whole loop can be verified without waiting for the cron.
 */
export async function sendTestPush(
  _req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const rows = await env.vence_db.prepare(
    `SELECT token FROM push_tokens WHERE user_id = ?1 AND disabled_at IS NULL`
  ).bind(auth.sub).all<{ token: string }>();

  const tokens = (rows.results ?? []).map(r => r.token);
  if (tokens.length === 0) {
    return json({ error: 'No tenés dispositivos registrados' }, 404, cors);
  }

  const result = await sendPush(env, tokens.map(to => ({
    to,
    title: 'Vence',
    body: 'Las notificaciones están funcionando.',
    data: { kind: 'test' },
    channelId: 'reminders',
  })));

  if (result.deadTokens.length) {
    await disableTokens(env, result.deadTokens);
  }

  return json({
    devices: tokens.length,
    sent: result.sent,
    disabled: result.deadTokens.length,
    errors: result.errors,
  }, 200, cors);
}

/** Mark tokens Expo rejected so the next sweep skips them. */
export async function disableTokens(env: Env, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await env.vence_db.batch(
    tokens.map(t =>
      env.vence_db.prepare(
        `UPDATE push_tokens SET disabled_at = unixepoch() WHERE token = ?1`
      ).bind(t)
    )
  );
}
