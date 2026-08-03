import type { Env } from '../env';
import type { AuthContext } from '../auth';
import { json } from '../helpers/helpers';

interface UnpaidRow {
  currency: string;
  bucket: 'pending' | 'overdue';
  count: number;
  total: number;
}

interface PaidRow {
  currency: string;
  count: number;
  total: number;
}

interface CurrencyTotal {
  currency: string;
  count: number;
  amount: number;
}

function currentMonthBounds(): { start: string; end: string } {
  // Start of this month (UTC), start of next month.
  // End is exclusive to make date < end the right filter.
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export async function getSummary(
  _req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const { start, end } = currentMonthBounds();

  const unpaidResult = await env.vence_db.prepare(
    `SELECT
       currency,
       CASE WHEN due_date < date('now') THEN 'overdue' ELSE 'pending' END AS bucket,
       COUNT(*) AS count,
       COALESCE(SUM(amount), 0) AS total
     FROM bills
     WHERE user_id = ?1
       AND deleted_at IS NULL
       AND paid_at IS NULL
     GROUP BY currency, bucket`
  ).bind(auth.sub).all<UnpaidRow>();

  const paidResult = await env.vence_db.prepare(
    `SELECT
       currency,
       COUNT(*) AS count,
       COALESCE(SUM(COALESCE(amount_paid, amount)), 0) AS total
     FROM bills
     WHERE user_id = ?1
       AND deleted_at IS NULL
       AND paid_at IS NOT NULL
       AND date(paid_at) >= date(?2)
       AND date(paid_at) < date(?3)
     GROUP BY currency`
  ).bind(auth.sub, start, end).all<PaidRow>();

  const pending: CurrencyTotal[] = [];
  const overdue: CurrencyTotal[] = [];
  for (const row of unpaidResult.results ?? []) {
    const entry = { currency: row.currency, count: row.count, amount: row.total };
    if (row.bucket === 'overdue') overdue.push(entry);
    else pending.push(entry);
  }

  const paidInPeriod: CurrencyTotal[] = (paidResult.results ?? []).map(row => ({
    currency: row.currency,
    count: row.count,
    amount: row.total,
  }));

  return json({
    period: { start, end },
    pending,
    overdue,
    paidInPeriod,
  }, 200, cors);
}