import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

interface CallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Omit to send the stub bearer token; null sends no Authorization header. */
  token?: string | null;
}

/**
 * Drives the real worker — real router, real handlers, real local D1 — with
 * auth stubbed at the module boundary (see helpers/auth.ts).
 *
 * Unit-style `worker.fetch` rather than `SELF.fetch` on purpose: SELF runs the
 * worker in a separate isolate where `vi.mock` does not apply, so the auth stub
 * would be bypassed.
 */
export async function call(path: string, options: CallOptions = {}) {
  const { method = 'GET', body, headers = {}, token } = options;

  const init: RequestInit = { method, headers: { ...headers } };
  if (token !== null) {
    (init.headers as Record<string, string>).Authorization = `Bearer ${token ?? 'stub-token'}`;
  }
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] ??= 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const request = new IncomingRequest(`https://worker.test${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** `call` plus a parsed JSON body, which is what most assertions want. */
export async function callJson<T = unknown>(path: string, options: CallOptions = {}) {
  const response = await call(path, options);
  const data = (await response.json().catch(() => null)) as T;
  return { status: response.status, body: data, headers: response.headers };
}
