import { Env } from '../env';

interface MonthlyRow {
  year_month: string;
  currency: string;
  amount: number;
  count: number;
}

export async function getMonthlySpend(
  req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const url = new URL(req.url);
  const monthsRaw = Number(url.searchParams.get('months') ?? '12');
  const months = Number.isInteger(monthsRaw) && monthsRaw >= 1 && monthsRaw <= 36 ? monthsRaw : 12;

  const now = new Date();
  const startY = now.getUTCFullYear();
  const startM = now.getUTCMonth() + 1 - (months - 1);
  const start = new Date(Date.UTC(startY, startM - 1, 1)).toISOString().slice(0, 10);
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

  const result = await env.vence_db.prepare(
    `SELECT
       strftime('%Y-%m', paid_at) AS year_month,
       currency,
       COUNT(*) AS count,
       COALESCE(SUM(COALESCE(amount_paid, amount)), 0) AS amount
     FROM bills
     WHERE user_id = ?1 AND deleted_at IS NULL AND paid_at IS NOT NULL
       AND date(paid_at) >= date(?2) AND date(paid_at) < date(?3)
     GROUP BY year_month, currency
     ORDER BY year_month ASC`
  ).bind(auth.sub, start, end).all<MonthlyRow>();

  // Fill months with no data so the chart shows a continuous X axis
  const keys: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(startY, startM - 1 + i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }

  const byMonth = new Map<string, { currency: string; amount: number; count: number }[]>();
  for (const row of result.results ?? []) {
    const list = byMonth.get(row.year_month) ?? [];
    list.push({ currency: row.currency, amount: row.amount, count: row.count });
    byMonth.set(row.year_month, list);
  }

  return json(
    { months: keys.map(k => ({ yearMonth: k, totals: byMonth.get(k) ?? [] })) },
    200,
    cors
  );
}

interface CategoryRow {
  category: string | null;
  currency: string;
  amount: number;
  count: number;
}

export async function getByCategory(
  req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const url = new URL(req.url);
  const now = new Date();
  const year = Number(url.searchParams.get('year') ?? now.getUTCFullYear());
  const month = Number(url.searchParams.get('month') ?? now.getUTCMonth() + 1);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return json({ error: 'year inválido' }, 400, cors);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return json({ error: 'month inválido' }, 400, cors);
  }

  const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  const end   = new Date(Date.UTC(year, month,     1)).toISOString().slice(0, 10);

  const result = await env.vence_db.prepare(
    `SELECT p.category, b.currency,
            COUNT(*) AS count,
            COALESCE(SUM(COALESCE(b.amount_paid, b.amount)), 0) AS amount
       FROM bills b
       LEFT JOIN providers p ON p.id = b.provider_id
      WHERE b.user_id = ?1 AND b.deleted_at IS NULL AND b.paid_at IS NOT NULL
        AND date(b.paid_at) >= date(?2) AND date(b.paid_at) < date(?3)
      GROUP BY p.category, b.currency
      ORDER BY amount DESC`
  ).bind(auth.sub, start, end).all<CategoryRow>();

  const byCat = new Map<string, { currency: string; amount: number; count: number }[]>();
  for (const row of result.results ?? []) {
    const cat = row.category ?? 'otro';
    const list = byCat.get(cat) ?? [];
    list.push({ currency: row.currency, amount: row.amount, count: row.count });
    byCat.set(cat, list);
  }

  return json({
    period: { start, end },
    categories: Array.from(byCat.entries()).map(([category, totals]) => ({ category, totals })),
  }, 200, cors);
}