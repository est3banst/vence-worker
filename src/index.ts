import { authenticate, upsertUser, AuthError } from './auth';
import type { AuthContext } from './auth';
import type { Env } from './env';
import { json, corsHeaders } from './helpers/helpers';

import { getSummary } from './analytics/analytics';
import { 
  createProvider, 
  updateProvider, 
  deleteProvider, 
  listProviders } 
from './providers/providers';
import { 
  createBill, 
  listBills, 
  payBill ,
  updateBill, 
  deleteBill} 
from './bills/bills';
import { listDocumentsByMonth } from './documents/documents';
import {
  getMySubscription,
  createCheckout,
  cancelMySubscription,
} from './handlers/subscriptions';
import { handleMercadoPagoWebhook } from './handlers/mpago-webhook';
import { getPreferences, updatePreferences } from './handlers/preferences';
import { deleteAccount } from './handlers/account';
import { getByCategory, getMonthlySpend } from './handlers/analytics';

// import { getPreferences, updatePreferences } from './handlers/preferences';
// import { uploadDocument, listDocuments, downloadDocument, deleteDocument } from './handlers/documents';

type Handler = (
  req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>,
  params: Record<string, string>
) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
  public?: boolean; // skip auth
}

// Small route builder. `:name` in the path becomes a capture group and lands in `params`.
function route(method: string, path: string, handler: Handler, opts: { public?: boolean } = {}): Route {
  const paramNames: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return '([A-Za-z0-9_-]+)';
      }) +
      '/?$'
  );
  return { method, pattern, paramNames, handler, public: opts.public };
}

// Public wrapper for routes that don't need auth (health).
function publicHandler(fn: (req: Request, env: Env, cors: Record<string, string>) => Promise<Response>): Handler {
  return (req, env, _auth, cors) => fn(req, env, cors);
}

const routes: Route[] = [
  // ─── Public ───
  route('GET', '/health', publicHandler(async (_r, _e, cors) => json({ ok: true }, 200, cors)), { public: true }),

  // ─── Me ───
  route('GET', '/me', async (_req, _env, auth, cors) =>
    json({ id: auth.sub, email: auth.email ?? null }, 200, cors)
  ),

  // ─── Providers ───
  route('POST', '/providers', (req, env, auth, cors) => createProvider(req, env, auth, cors)),
  route('GET',  '/providers', (_req, env, auth, cors) => listProviders(env, auth, cors)),
  route('PATCH',  '/providers/:id', (req, env, auth, cors, p) => updateProvider(req, env, auth, p.id, cors)),
  route('DELETE', '/providers/:id', (_req, env, auth, cors, p) => deleteProvider(env, auth, p.id, cors)),

  // ─── Bills ───  (add as handlers land)
  route('POST',   '/bills',                 (req, env, auth, cors) => createBill(req, env, auth, cors)),
  route('GET',    '/bills',                 (req, env, auth, cors) => listBills(env, auth, cors)),
  route('POST', '/bills/:id/pay', (req, env, auth, cors, p) => payBill(req, env, auth, p.id, cors)),
  
  route('PATCH',  '/bills/:id',             (req, env, auth, cors, p) => updateBill(req, env, auth, p.id, cors)),
  route('DELETE', '/bills/:id',             (_req, env, auth, cors, p) => deleteBill(env, auth, p.id, cors)),
  // route('POST',   '/bills/:id/pay',         (req, env, auth, cors, p) => payBill(req, env, auth, p.id, cors)),

  route('GET', '/analytics/summary', (req, env, auth, cors) => getSummary(req, env, auth, cors)),
  route('GET', '/analytics/monthly',     (req, env, auth, cors) => getMonthlySpend(req, env, auth, cors)),
  route('GET', '/analytics/by-category', (req, env, auth, cors) => getByCategory(req, env, auth, cors)),


  route('GET',  '/subscriptions/me',        (req, env, auth, cors) => getMySubscription(req, env, auth, cors)),
  route('POST', '/subscriptions/checkout',  (req, env, auth, cors) => createCheckout(req, env, auth, cors)),
  route('POST', '/subscriptions/cancel',    (req, env, auth, cors) => cancelMySubscription(req, env, auth, cors)),

// Public — MP calls this. `publicHandler` skips auth.
  route('POST', '/webhooks/mercadopago',
    publicHandler((req, env, cors) => handleMercadoPagoWebhook(req, env, cors)),
    { public: true }
  ),

  // ─── Documents ───
  // route('POST',   '/bills/:billId/documents', (req, env, auth, cors, p) => uploadDocument(req, env, auth, p.billId, cors)),
  // route('GET',    '/bills/:billId/documents', (_req, env, auth, cors, p) => listDocuments(env, auth, p.billId, cors)),
  
  route('GET', '/documents', (req, env, auth, cors) => listDocumentsByMonth(req, env, auth, cors)),
  // route('GET',    '/documents/:id',           (_req, env, auth, cors, p) => downloadDocument(env, auth, p.id, cors)),
  // route('DELETE', '/documents/:id',           (_req, env, auth, cors, p) => deleteDocument(env, auth, p.id, cors)),

  // ─── Preferences ───
  route('GET',    '/preferences',      (req, env, auth, cors) => getPreferences(req, env, auth, cors)),
  route('PATCH',  '/preferences',      (req, env, auth, cors) => updatePreferences(req, env, auth, cors)),
  route('DELETE', '/account',          (req, env, auth, cors) => deleteAccount(req, env, auth, cors)),

];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = corsHeaders(env.ALLOWED_ORIGIN || '*');

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Find a matching route (any method) to distinguish 404 from 405.
    const matches = routes.filter(r => r.pattern.test(url.pathname));
    if (matches.length === 0) {
      return json({ error: 'Not found' }, 404, cors);
    }

    const route = matches.find(r => r.method === req.method);
    if (!route) {
      const allowed = matches.map(r => r.method).join(', ');
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...cors, 'Content-Type': 'application/json', Allow: allowed },
      });
    }

    const match = route.pattern.exec(url.pathname)!;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });

    try {
      let auth: AuthContext = { sub: '', email: undefined };
      if (!route.public) {
        auth = await authenticate(req, env);
        await upsertUser(env, auth);
      }
      return await route.handler(req, env, auth, cors, params);
    } catch (err) {
      if (err instanceof AuthError) return json({ error: err.message }, err.status, cors);
      console.error('Worker error:', err);
      const message = err instanceof Error ? err.message : 'Unknown error';
      return json({ error: message }, 500, cors);
    }
  },
} satisfies ExportedHandler<Env>;