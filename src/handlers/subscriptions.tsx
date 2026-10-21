import type { Env } from '../env';
import type { AuthContext } from '../auth';
import { json } from '../helpers/helpers';
import { PLANS, type Plan } from '../helpers/plans';

const MP_API = 'https://api.mercadopago.com';

interface SubscriptionRow {
  id: string;
  user_id: string;
  tier: string;
  status: string;
  provider: string | null;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

// ─────────────── GET /subscriptions/me ───────────────

export async function getMySubscription(
  _req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const row = await env.vence_db.prepare(
    `SELECT * FROM subscriptions
      WHERE user_id = ?1 AND status IN ('active','trialing')
      LIMIT 1`
  ).bind(auth.sub).first<SubscriptionRow>();

  if (!row) {
    return json({ tier: 'free', status: 'active' }, 200, cors);
  }

  return json({
    id: row.id,
    tier: row.tier,
    status: row.status,
    currentPeriodEnd: row.current_period_end
      ? new Date(row.current_period_end * 1000).toISOString()
      : null,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
  }, 200, cors);
}

// ─────────────── POST /subscriptions/checkout ───────────────

export async function createCheckout(
  req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { tier?: string } | null;
  if (!body || typeof body.tier !== 'string' || !(body.tier in PLANS)) {
    return json({ error: 'Tier inválido' }, 400, cors);
  }
  const plan = PLANS[body.tier as Plan['id']];

  if (!auth.email) {
    return json({ error: 'Email requerido para pago' }, 400, cors);
  }

  // If user has an active subscription, we cancel it before creating the new one.
  // MP handles the actual charge cancellation; we just mark ours as pending-cancel
  // and let the webhook clean up when MP confirms.
  const existing = await env.vence_db.prepare(
    `SELECT id, provider_subscription_id, tier FROM subscriptions
      WHERE user_id = ?1 AND status IN ('active','trialing')
      LIMIT 1`
  ).bind(auth.sub).first<{ id: string; provider_subscription_id: string | null; tier: string }>();

  if (existing && existing.tier === plan.id) {
    return json({ error: 'Ya estás suscripto a este plan' }, 409, cors);
  }

  // Create preapproval on MP.
  // `external_reference` lets us find our subscription row from webhook payloads.
  const externalRef = crypto.randomUUID();
  const origin = new URL(req.url).origin;

  const preapprovalBody = {
    reason: plan.name,
    external_reference: externalRef,
    payer_email: auth.email,
    auto_recurring: {
      frequency: plan.frequency,
      frequency_type: plan.frequencyType,
      transaction_amount: plan.amount,
      currency_id: plan.currency,
    },
    back_url: `${env.ALLOWED_ORIGIN}/dashboard?checkout=return`,
    status: 'pending',
  };

  const mpResp = await fetch(`${MP_API}/preapproval`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': externalRef,
    },
    body: JSON.stringify(preapprovalBody),
  });

  if (!mpResp.ok) {
    const text = await mpResp.text();
    console.error('MP preapproval failed', mpResp.status, text);
    return json({ error: 'No se pudo iniciar el pago' }, 502, cors);
  }

  const preapproval = await mpResp.json() as {
    id: string;
    init_point: string;
    status: string;
  };

  // Insert a pending subscription row so the webhook has something to update.
  await env.vence_db.prepare(
    `INSERT INTO subscriptions
       (id, user_id, tier, status, provider, provider_subscription_id, metadata,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, 'past_due', 'mercadopago', ?4, ?5, unixepoch(), unixepoch())`
  ).bind(
    crypto.randomUUID(),
    auth.sub,
    plan.id,
    preapproval.id,
    JSON.stringify({ externalRef, previousSubscriptionId: existing?.id ?? null }),
  ).run();

  // If there was an existing subscription and it's a different plan, cancel
  // it on MP. We only mark ours as cancelled once the webhook confirms.
  if (existing?.provider_subscription_id) {
    await cancelPreapproval(env, existing.provider_subscription_id).catch(err => {
      console.error('Failed to cancel previous MP preapproval', err);
    });
  }

  return json({
    preapprovalId: preapproval.id,
    initPoint: preapproval.init_point,
    publicKey: env.MP_PUBLIC_KEY,
  }, 200, cors);
}

// ─────────────── POST /subscriptions/cancel ───────────────

export async function cancelMySubscription(
  _req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const existing = await env.vence_db.prepare(
    `SELECT id, provider_subscription_id FROM subscriptions
      WHERE user_id = ?1 AND status IN ('active','trialing')
      LIMIT 1`
  ).bind(auth.sub).first<{ id: string; provider_subscription_id: string | null }>();

  if (!existing) {
    return json({ error: 'No tenés una suscripción activa' }, 404, cors);
  }

  if (existing.provider_subscription_id) {
    await cancelPreapproval(env, existing.provider_subscription_id);
  }

  // We mark cancel_at_period_end = 1 rather than immediately terminating.
  // The webhook `cancelled` event finalizes the transition.
  await env.vence_db.prepare(
    `UPDATE subscriptions
        SET cancel_at_period_end = 1, updated_at = unixepoch()
      WHERE id = ?1`
  ).bind(existing.id).run();

  return json({ ok: true }, 200, cors);
}

async function cancelPreapproval(env: Env, preapprovalId: string): Promise<void> {
  const resp = await fetch(`${MP_API}/preapproval/${preapprovalId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'cancelled' }),
  });
  if (!resp.ok) {
    throw new Error(`MP cancel failed: ${resp.status}`);
  }
}