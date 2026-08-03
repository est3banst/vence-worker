
export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH,DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Filename, Authorization',
    'Access-Control-Expose-Headers': 'Content-Disposition',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function json(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && id.length > 0 && id.length <= 128;
}

export function sanitizeFilename(input: string | null): string {
  if (!input) return 'recibo.pdf';
  let decoded = input;
  try { decoded = decodeURIComponent(input); } catch { /* keep raw */ }
  const base = decoded.split(/[/\\]/).pop() ?? 'recibo.pdf';
  const clean = base.replace(/[\x00-\x1f<>:"|?*]/g, '_').slice(0, 200).trim();
  return clean || 'recibo.pdf';
}