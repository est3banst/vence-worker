import type { Env } from '../env';
import type { AuthContext } from '../auth';
import { json } from '../helpers/helpers';
import { sendPush, checkReceipts, receiptWait } from '../notifications/expo';

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

  const res = await env.vence_db.prepare(
    `DELETE FROM push_tokens WHERE token = ?1 AND user_id = ?2`
  ).bind(token, auth.sub).run();

  // Whether a row actually went is the difference between "you're unregistered"
  // and "that token was never here" — which is what a client sees when its
  // install has rotated its token and the old one is still on file. Reporting
  // `true` for a no-op is how the UI came to claim a device was switched off
  // while the server still held it.
  return json({ deleted: (res.meta?.changes ?? 0) > 0 }, 200, cors);
}

// How long to give Expo to produce a receipt before reporting back. Delivery
// errors land in seconds; this only has to outlast that, not the slowest case.
const RECEIPT_WAIT_MS = 1500;
const RECEIPT_ATTEMPTS = 3;

/**
 * POST /push/test — send a push to the caller's own devices and report whether
 * it was *delivered*.
 *
 * Exists so the whole loop can be verified without waiting for the cron, which
 * means it has to check receipts rather than tickets. Reporting an accepted
 * ticket as success made this endpoint answer "sent to 1 of 1 device" for a
 * token that FCM had already stopped recognising — the one question the button
 * exists to answer, answered wrongly.
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

  const dead = new Set(result.deadTokens);
  let delivered = 0;
  let pending = result.tickets.length;
  // Each round replaces the last rather than appending: a receipt that was
  // merely undecided a second ago should not leave an error behind once it
  // resolves. Only the final round's findings are reported.
  let receiptErrors: string[] = [];

  // Poll until every accepted message has a verdict, or the attempts run out.
  for (let attempt = 0; attempt < RECEIPT_ATTEMPTS && pending > 0; attempt++) {
    await receiptWait(env, RECEIPT_WAIT_MS);
    const receipts = await checkReceipts(env, result.tickets);
    delivered = receipts.delivered;
    pending = receipts.pending;
    receiptErrors = receipts.errors;
    receipts.deadTokens.forEach(t => dead.add(t));
  }

  const errors = [...result.errors, ...receiptErrors];

  if (dead.size > 0) await disableTokens(env, [...dead]);

  return json({
    devices: tokens.length,
    // Accepted by Expo. Kept because an older client reads it.
    sent: result.sent,
    // Confirmed on the device's transport — this is the one that matters.
    delivered,
    pending,
    disabled: dead.size,
    errors,
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
