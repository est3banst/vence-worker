import type { Env } from '../env';
import type { AuthContext } from '../auth';
import { json } from '../helpers/helpers';
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * Delete the user's account permanently.
 *
 * Order matters:
 *   1. Cancel any active MP subscription (best-effort, don't block on failure).
 *   2. Delete Cognito user. If this fails, we bail — leaving Cognito+D1
 *      out of sync would be worse than failing loudly.
 *   3. Delete D1 rows. ON DELETE CASCADE handles bills/documents/providers.
 *
 * R2 objects are NOT deleted synchronously — a scheduled cleanup job (not
 * built yet) reaps orphans. This means storage cost lingers briefly for
 * deleted users. Acceptable trade at this scale.
 */
export async function deleteAccount(
  req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { confirmEmail?: string } | null;

  if (!body?.confirmEmail || body.confirmEmail.trim().toLowerCase() !== (auth.email ?? '').toLowerCase()) {
    return json({ error: 'Confirmación de email no coincide' }, 400, cors);
  }

  // Best-effort MP cancellation
  const activeSub = await env.vence_db.prepare(
    `SELECT provider_subscription_id FROM subscriptions
      WHERE user_id = ?1 AND status IN ('active','trialing')
      LIMIT 1`
  ).bind(auth.sub).first<{ provider_subscription_id: string | null }>();

  if (activeSub?.provider_subscription_id) {
    try {
      await fetch(`https://api.mercadopago.com/preapproval/${activeSub.provider_subscription_id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'cancelled' }),
      });
    } catch (err) {
      // Log and continue — we still want to delete the account
      console.error('MP cancel during account delete failed', err);
    }
  }

  const cognito = new CognitoIdentityProviderClient({
    region: env.COGNITO_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  try {
    await cognito.send(new AdminDeleteUserCommand({
      UserPoolId: env.COGNITO_USER_POOL_ID,
      Username: auth.sub,
    }));
  } catch (err) {
    console.error('Cognito delete failed', err);
    return json({ error: 'No pudimos eliminar la cuenta. Escribinos.' }, 500, cors);
  }

  // Delete D1 — cascade handles the rest
  await env.vence_db.prepare(
    `DELETE FROM users WHERE id = ?1`
  ).bind(auth.sub).run();

  return json({ deleted: true }, 200, cors);
}