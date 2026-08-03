import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './env';

/**
 * Cognito JWT verification.
 *
 * We verify the ID token (token_use = 'id'). Reasons:
 *   - The audience claim is set to our Client ID, which jose can verify directly.
 *   - The ID token carries the user's email, useful for the users table.
 *
 * If you switch to access tokens later, remove the `audience` option and
 * verify `payload.client_id === env.COGNITO_CLIENT_ID` manually, then check
 * `payload.token_use === 'access'`.
 *
 * The JWKS resolver is cached at module scope. jose handles fetch + key cache
 * internally with sensible defaults (10 min TTL).
 */

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksConfig: { region: string; poolId: string } | null = null;

function getJWKS(env: Env): ReturnType<typeof createRemoteJWKSet> {
  if (
    !jwks ||
    !jwksConfig ||
    jwksConfig.region !== env.COGNITO_REGION ||
    jwksConfig.poolId !== env.COGNITO_USER_POOL_ID
  ) {
    const url = new URL(
      `https://cognito-idp.${env.COGNITO_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`
    );
    jwks = createRemoteJWKSet(url);
    jwksConfig = {
      region: env.COGNITO_REGION,
      poolId: env.COGNITO_USER_POOL_ID,
    };
  }
  return jwks;
}

export interface AuthContext {
  sub: string;
  email?: string;
}

export class AuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function authenticate(req: Request, env: Env): Promise<AuthContext> {
  const header = req.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    throw new AuthError(401, 'Falta el token de autenticación');
  }
  const token = header.slice(7).trim();
  if (!token) {
    throw new AuthError(401, 'Token vacío');
  }

  const issuer = `https://cognito-idp.${env.COGNITO_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}`;

  try {
    const { payload } = await jwtVerify(token, getJWKS(env), {
      issuer,
      audience: env.COGNITO_CLIENT_ID,
    });

    if (payload.token_use !== 'id') {
      throw new AuthError(401, 'Se requiere un ID token (recibido: ' + String(payload.token_use) + ')');
    }
    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new AuthError(401, 'Token sin sub');
    }

    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const msg = err instanceof Error ? err.message : 'Token inválido';
    throw new AuthError(401, msg);
  }
}

/**
 * Upsert the user row. Called after every successful authenticate().
 * COALESCE on email so a re-login with email scrubbed doesn't wipe it.
 */
export async function upsertUser(env: Env, auth: AuthContext): Promise<void> {
  await env.vence_db.prepare(
    `INSERT INTO users (id, email)
     VALUES (?1, ?2)
     ON CONFLICT(id) DO UPDATE SET
       email = COALESCE(excluded.email, users.email),
       last_seen_at = unixepoch()`
  )
    .bind(auth.sub, auth.email ?? null)
    .run();
}
