import type { Env } from '../env';
import { json } from '../helpers/helpers';

const MP_API = 'https://api.mercadopago.com';

interface PreapprovalData {
  id: string;
  status: 'pending' | 'authorized' | 'paused' | 'cancelled';
  external_reference?: string;
  next_payment_date?: string;
  reason?: string;
}

/**
 * Verify MP webhook signature. Format of x-signature header:
 *   ts=1234567890,v1=<hex_hmac>
 * Where hmac is HMAC-SHA256 of `id:<resourceId>;request-id:<xRequestId>;ts:<ts>;`
 * using the webhook secret.
 */
async function verifySignature(
  req: Request,
  secret: string,
  resourceId: string
): Promise<boolean> {
  const sigHeader = req.headers.get('x-signature');
  const requestId = req.headers.get('x-request-id');
  if (!sigHeader || !requestId) return false;

  const parts = Object.fromEntries(
    sigHeader.split(',').map(kv => {
      const [k, v] = kv.trim().split('=');
      return [k, v];
    })
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  // Reject stale (>5min old) or future-dated timestamps
  const now = Math.floor(Date.now() / 1000);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 300) return false;

  const manifest = `id:${resourceId};request-id:${requestId};ts:${ts};`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(manifest)
  );
  const computed = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time compare
  if (computed.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  return diff === 0;
}

export async function handleMercadoPagoWebhook(
  req: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  const url = new URL(req.url);
  const type = url.searchParams.get('type') ?? url.searchParams.get('topic');
  const dataId = url.searchParams.get('data.id') ?? url.searchParams.get('id');

  // Always respond 200 to MP, even for events we don't care about.
  // Non-200 makes MP retry, which we don't want.
  if (type !== 'preapproval' || !dataId) {
    return json({ received: true }, 200, cors);
  }

  const valid = await verifySignature(req, env.MP_WEBHOOK_SECRET, dataId);
  if (!valid) {
    console.error('Invalid MP webhook signature', { type, dataId });
    return json({ error: 'Invalid signature' }, 401, cors);
  }

  // Fetch the preapproval from MP — the webhook only tells us "something changed."
  const mpResp = await fetch(`${MP_API}/preapproval/${dataId}`, {
    headers: { 'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}` },
  });
  if (!mpResp.ok) {
    console.error('MP preapproval fetch failed', mpResp.status);
    return json({ received: true }, 200, cors);
  }
  const preapproval = await mpResp.json() as PreapprovalData;

  await applyPreapprovalState(env, preapproval);

  return json({ received: true }, 200, cors);
}

async function applyPreapprovalState(env: Env, pre: PreapprovalData): Promise<void> {
  const row = await env.vence_db.prepare(
    `SELECT id, status, cancel_at_period_end, metadata
       FROM subscriptions
      WHERE provider_subscription_id = ?1`
  ).bind(pre.id).first<{
    id: string;
    status: string;
    cancel_at_period_end: number;
    metadata: string | null;
  }>();

  if (!row) {
    console.warn('Webhook for unknown preapproval', pre.id);
    return;
  }

  const currentPeriodEnd = pre.next_payment_date
    ? Math.floor(new Date(pre.next_payment_date).getTime() / 1000)
    : null;

  let nextStatus: string;
  switch (pre.status) {
    case 'authorized':
      nextStatus = 'active';
      break;
    case 'paused':
      nextStatus = 'past_due';
      break;
    case 'cancelled':
      nextStatus = 'cancelled';
      break;
    case 'pending':
      nextStatus = 'past_due';
      break;
    default:
      nextStatus = row.status;
  }

  await env.vence_db.prepare(
    `UPDATE subscriptions
        SET status = ?1, current_period_end = ?2, updated_at = unixepoch()
      WHERE id = ?3`
  ).bind(nextStatus, currentPeriodEnd, row.id).run();

  // If the new sub just became active AND there's a `previousSubscriptionId`
  // in metadata, retire that predecessor. Idempotent — safe to run twice.
  if (nextStatus === 'active' && row.metadata) {
    try {
      const meta = JSON.parse(row.metadata) as { previousSubscriptionId?: string | null };
      if (meta.previousSubscriptionId) {
        await env.vence_db.prepare(
          `UPDATE subscriptions
              SET status = 'cancelled', updated_at = unixepoch()
            WHERE id = ?1 AND status != 'cancelled'`
        ).bind(meta.previousSubscriptionId).run();
      }
    } catch {
      // Bad metadata; skip cleanup, log
      console.error('Malformed subscription metadata', row.metadata);
    }
  }
}