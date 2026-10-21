import { vi } from 'vitest';

/**
 * Global auth stub, registered for every spec.
 *
 * authenticate() is the one layer that can't run for real: it verifies a
 * Cognito JWT against a remote JWKS. Everything else — routing, handlers,
 * validation, D1 — is exercised genuinely.
 *
 * `vi.mock` is hoisted per-file and its specifier resolves relative to the file
 * it is written in, so this lives here rather than in a helper function (which
 * would neither hoist nor resolve correctly).
 *
 * Tokens with meaning:
 *   'stub-token' (the default) → USER_A with an email
 *   'user-b'                   → USER_B
 *   'no-email'                 → USER_A with no email claim
 *   'expired'                  → 401
 */
vi.mock('../src/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/auth')>('../src/auth');
  return {
    ...actual,
    authenticate: vi.fn(async (req: Request) => {
      const header = req.headers.get('Authorization') ?? '';
      if (!header.startsWith('Bearer ')) {
        throw new actual.AuthError(401, 'Falta el token de autenticación');
      }
      const token = header.slice(7).trim();
      if (!token) throw new actual.AuthError(401, 'Token vacío');
      if (token === 'expired') throw new actual.AuthError(401, 'Token expirado');
      if (token === 'user-b') return { sub: 'cognito-sub-bbbb', email: 'b@vence.uy' };
      if (token === 'no-email') return { sub: 'cognito-sub-aaaa', email: undefined };
      return { sub: 'cognito-sub-aaaa', email: 'a@vence.uy' };
    }),
  };
});
