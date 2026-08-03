import type { Env } from '../env';
import type { AuthContext } from '../auth';
import { json } from '../helpers/helpers';

const VALID_CURRENCIES = ['UYU', 'USD', 'EUR', 'ARS'] as const;
const VALID_FREQUENCIES = [
  'unica', 'mensual', 'bimestral', 'trimestral', 'semestral', 'anual',
] as const;
const VALID_STATUSES = ['pendiente', 'pagada', 'vencida'] as const;

interface BillRow {
  id: string;
  provider_id: string;
  amount: number;
  currency: string;
  due_date: string;
  frequency: string;
  status: string;
  reference: string | null;
  notes: string | null;
  paid_at: string | null;
  amount_paid: number | null;
  created_at: number;
  updated_at: number;
}

function toDto(row: BillRow) {
  // Derive display status: unpaid + past due → 'vencida'. DB may still say
  // 'pendiente'; the label is a UI concern, not a stored state.
  let status = row.status;
  if (!row.paid_at && status === 'pendiente') {
    const today = new Date().toISOString().slice(0, 10);
    if (row.due_date < today) status = 'vencida';
  }

  return {
    id: row.id,
    providerId: row.provider_id,
    amount: row.amount,
    currency: row.currency,
    dueDate: row.due_date,
    frequency: row.frequency,
    status,
    reference: row.reference ?? undefined,
    notes: row.notes ?? undefined,
    paidAt: row.paid_at ?? undefined,
    amountPaid: row.amount_paid ?? undefined,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
  };
}

function isValidDueDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  // Round-trip check catches invalid dates that JS silently rolls over (e.g. Feb 30 → Mar 2)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidPaidAt(s: string): boolean {
  const d = new Date(s);
  return !isNaN(d.getTime());
}

async function providerBelongsToUser(
  env: Env,
  userId: string,
  providerId: string
): Promise<boolean> {
  const row = await env.vence_db.prepare(
    `SELECT id FROM providers
      WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`
  ).bind(providerId, userId).first();
  return row !== null;
}

// ────────────────────────── createBill ──────────────────────────

export async function createBill(
  req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return json({ error: 'Body inválido' }, 400, cors);
  }

  const providerId =
    typeof body.providerId === 'string' && body.providerId.trim()
      ? body.providerId.trim()
      : '';
  if (!providerId) {
    return json({ error: 'providerId requerido' }, 400, cors);
  }

  if (typeof body.amount !== 'number' || !isFinite(body.amount) || body.amount <= 0) {
    return json({ error: 'amount debe ser un número mayor a 0' }, 400, cors);
  }
  const amount = body.amount;

  if (
    typeof body.currency !== 'string' ||
    !(VALID_CURRENCIES as readonly string[]).includes(body.currency)
  ) {
    return json(
      { error: `currency inválida (valores: ${VALID_CURRENCIES.join(', ')})` },
      400,
      cors
    );
  }
  const currency = body.currency;

  if (typeof body.dueDate !== 'string' || !isValidDueDate(body.dueDate)) {
    return json({ error: 'dueDate debe tener formato YYYY-MM-DD' }, 400, cors);
  }
  const dueDate = body.dueDate;

  if (
    typeof body.frequency !== 'string' ||
    !(VALID_FREQUENCIES as readonly string[]).includes(body.frequency)
  ) {
    return json(
      { error: `frequency inválida (valores: ${VALID_FREQUENCIES.join(', ')})` },
      400,
      cors
    );
  }
  const frequency = body.frequency;

  const notes =
    typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
  if (notes && notes.length > 2000) {
    return json({ error: 'notes muy largo (máx 2000 caracteres)' }, 400, cors);
  }

  const reference =
    typeof body.reference === 'string' && body.reference.trim()
      ? body.reference.trim()
      : null;
  if (reference && reference.length > 200) {
    return json({ error: 'reference muy largo (máx 200 caracteres)' }, 400, cors);
  }

  const ok = await providerBelongsToUser(env, auth.sub, providerId);
  if (!ok) {
    return json({ error: 'Proveedor no encontrado' }, 400, cors);
  }

  const id = crypto.randomUUID();

  await env.vence_db.prepare(
    `INSERT INTO bills
       (id, user_id, provider_id, amount, currency, due_date, frequency, status,
        reference, notes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pendiente', ?8, ?9, unixepoch(), unixepoch())`
  )
    .bind(id, auth.sub, providerId, amount, currency, dueDate, frequency, reference, notes)
    .run();

  const row = await env.vence_db.prepare(
    `SELECT id, provider_id, amount, currency, due_date, frequency, status,
            reference, notes, paid_at, amount_paid, created_at, updated_at
       FROM bills WHERE id = ?1`
  ).bind(id).first<BillRow>();

  return json(toDto(row!), 201, cors);
}

// ────────────────────────── listBills ──────────────────────────

export async function listBills(
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const result = await env.vence_db.prepare(
    `SELECT id, provider_id, amount, currency, due_date, frequency, status,
            reference, notes, paid_at, amount_paid, created_at, updated_at
       FROM bills
      WHERE user_id = ?1 AND deleted_at IS NULL
      ORDER BY due_date ASC`
  ).bind(auth.sub).all<BillRow>();

  return json({ bills: (result.results ?? []).map(toDto) }, 200, cors);
}

// ────────────────────────── updateBill ──────────────────────────

export async function updateBill(
  req: Request,
  env: Env,
  auth: AuthContext,
  billId: string,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return json({ error: 'Body inválido' }, 400, cors);
  }

  const existing = await env.vence_db.prepare(
    `SELECT id, provider_id, amount, currency, due_date, frequency, status,
            reference, notes, paid_at, amount_paid, created_at, updated_at
       FROM bills
      WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`
  ).bind(billId, auth.sub).first<BillRow>();

  if (!existing) {
    return json({ error: 'Cuenta no encontrada' }, 404, cors);
  }

  // Each field: undefined → keep, null/'' for optional strings → clear.

  let providerId = existing.provider_id;
  if (body.providerId !== undefined) {
    if (typeof body.providerId !== 'string' || !body.providerId.trim()) {
      return json({ error: 'providerId inválido' }, 400, cors);
    }
    const next = body.providerId.trim();
    if (next !== existing.provider_id) {
      const ok = await providerBelongsToUser(env, auth.sub, next);
      if (!ok) return json({ error: 'Proveedor no encontrado' }, 400, cors);
    }
    providerId = next;
  }

  let amount = existing.amount;
  if (body.amount !== undefined) {
    if (typeof body.amount !== 'number' || !isFinite(body.amount) || body.amount <= 0) {
      return json({ error: 'amount debe ser un número mayor a 0' }, 400, cors);
    }
    amount = body.amount;
  }

  let currency = existing.currency;
  if (body.currency !== undefined) {
    if (
      typeof body.currency !== 'string' ||
      !(VALID_CURRENCIES as readonly string[]).includes(body.currency)
    ) {
      return json(
        { error: `currency inválida (valores: ${VALID_CURRENCIES.join(', ')})` },
        400,
        cors
      );
    }
    currency = body.currency;
  }

  let dueDate = existing.due_date;
  if (body.dueDate !== undefined) {
    if (typeof body.dueDate !== 'string' || !isValidDueDate(body.dueDate)) {
      return json({ error: 'dueDate debe tener formato YYYY-MM-DD' }, 400, cors);
    }
    dueDate = body.dueDate;
  }

  let frequency = existing.frequency;
  if (body.frequency !== undefined) {
    if (
      typeof body.frequency !== 'string' ||
      !(VALID_FREQUENCIES as readonly string[]).includes(body.frequency)
    ) {
      return json(
        { error: `frequency inválida (valores: ${VALID_FREQUENCIES.join(', ')})` },
        400,
        cors
      );
    }
    frequency = body.frequency;
  }

  let status = existing.status;
  if (body.status !== undefined) {
    if (
      typeof body.status !== 'string' ||
      !(VALID_STATUSES as readonly string[]).includes(body.status)
    ) {
      return json(
        { error: `status inválido (valores: ${VALID_STATUSES.join(', ')})` },
        400,
        cors
      );
    }
    status = body.status;
  }

  let reference: string | null = existing.reference;
  if (body.reference !== undefined) {
    if (body.reference === null || body.reference === '') {
      reference = null;
    } else if (typeof body.reference === 'string') {
      const trimmed = body.reference.trim();
      if (trimmed.length > 200) {
        return json({ error: 'reference muy largo (máx 200 caracteres)' }, 400, cors);
      }
      reference = trimmed || null;
    } else {
      return json({ error: 'reference debe ser texto' }, 400, cors);
    }
  }

  let notes: string | null = existing.notes;
  if (body.notes !== undefined) {
    if (body.notes === null || body.notes === '') {
      notes = null;
    } else if (typeof body.notes === 'string') {
      const trimmed = body.notes.trim();
      if (trimmed.length > 2000) {
        return json({ error: 'notes muy largo (máx 2000 caracteres)' }, 400, cors);
      }
      notes = trimmed || null;
    } else {
      return json({ error: 'notes debe ser texto' }, 400, cors);
    }
  }

  let paidAt: string | null = existing.paid_at;
  if (body.paidAt !== undefined) {
    if (body.paidAt === null || body.paidAt === '') {
      paidAt = null;
    } else if (typeof body.paidAt === 'string' && isValidPaidAt(body.paidAt)) {
      paidAt = body.paidAt;
    } else {
      return json({ error: 'paidAt debe ser una fecha ISO válida' }, 400, cors);
    }
  }

  let amountPaid: number | null = existing.amount_paid;
  if (body.amountPaid !== undefined) {
    if (body.amountPaid === null) {
      amountPaid = null;
    } else if (
      typeof body.amountPaid === 'number' &&
      isFinite(body.amountPaid) &&
      body.amountPaid > 0
    ) {
      amountPaid = body.amountPaid;
    } else {
      return json({ error: 'amountPaid debe ser un número mayor a 0' }, 400, cors);
    }
  }

  await env.vence_db.prepare(
    `UPDATE bills
        SET provider_id = ?1, amount = ?2, currency = ?3, due_date = ?4,
            frequency = ?5, status = ?6, reference = ?7, notes = ?8,
            paid_at = ?9, amount_paid = ?10, updated_at = unixepoch()
      WHERE id = ?11 AND user_id = ?12`
  )
    .bind(
      providerId, amount, currency, dueDate, frequency, status,
      reference, notes, paidAt, amountPaid, billId, auth.sub
    )
    .run();

  const updated = await env.vence_db.prepare(
    `SELECT id, provider_id, amount, currency, due_date, frequency, status,
            reference, notes, paid_at, amount_paid, created_at, updated_at
       FROM bills WHERE id = ?1`
  ).bind(billId).first<BillRow>();

  return json(toDto(updated!), 200, cors);
}

// ────────────────────────── deleteBill ──────────────────────────

export async function deleteBill(
  env: Env,
  auth: AuthContext,
  billId: string,
  cors: Record<string, string>
): Promise<Response> {
  // Soft-delete the bill and cascade soft-delete its documents (metadata rows).
  // R2 objects stay put — hard cleanup is a separate job.
  const results = await env.vence_db.batch([
    env.vence_db.prepare(
      `UPDATE bills
          SET deleted_at = unixepoch(), updated_at = unixepoch()
        WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`
    ).bind(billId, auth.sub),
    env.vence_db.prepare(
      `UPDATE documents
          SET deleted_at = unixepoch()
        WHERE bill_id = ?1 AND user_id = ?2 AND deleted_at IS NULL`
    ).bind(billId, auth.sub),
  ]);

  if ((results[0].meta?.changes ?? 0) === 0) {
    return json({ error: 'Cuenta no encontrada' }, 404, cors);
  }

  return json(
    {
      deleted: true,
      id: billId,
      documentsAffected: results[1].meta?.changes ?? 0,
    },
    200,
    cors
  );
}

/**
 * Add N months to a YYYY-MM-DD date, clamping to the last day of the
 * target month. All arithmetic in UTC to avoid TZ shifts.
 *
 * Examples:
 *   addFrequency('2026-01-31', 'mensual') → '2026-02-28'
 *   addFrequency('2026-01-15', 'mensual') → '2026-02-15'
 *   addFrequency('2026-06-30', 'anual')   → '2027-06-30'
 *   addFrequency('2026-06-30', 'unica')   → null
 */
function addFrequency(dueDate: string, frequency: string): string | null {
  const months: Record<string, number> = {
    mensual: 1, bimestral: 2, trimestral: 3, semestral: 6, anual: 12,
  };
  const delta = months[frequency];
  if (delta === undefined) return null; // 'unica' or unknown

  const [y, m, d] = dueDate.split('-').map(Number);
  const targetMonthIdx = m - 1 + delta; // JS months are 0-11
  const targetYear = y + Math.floor(targetMonthIdx / 12);
  const normalizedMonth = ((targetMonthIdx % 12) + 12) % 12;

  // Last day of target month: day 0 of month+1 in UTC
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d, lastDay);

  const mm = String(normalizedMonth + 1).padStart(2, '0');
  const dd = String(clampedDay).padStart(2, '0');
  return `${targetYear}-${mm}-${dd}`;
}

export async function payBill(
  req: Request,
  env: Env,
  auth: AuthContext,
  billId: string,
  cors: Record<string, string>
): Promise<Response> {
  // Body is entirely optional; defaults are "paid now, full amount"
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const existing = await env.vence_db.prepare(
    `SELECT id, provider_id, amount, currency, due_date, frequency, status,
            reference, notes, paid_at, amount_paid, created_at, updated_at
       FROM bills
      WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`
  ).bind(billId, auth.sub).first<BillRow>();

  if (!existing) {
    return json({ error: 'Cuenta no encontrada' }, 404, cors);
  }
  if (existing.paid_at !== null) {
    return json({ error: 'La cuenta ya está pagada' }, 409, cors);
  }

  let paidAt: string;
  if (body.paidAt !== undefined) {
    if (typeof body.paidAt !== 'string' || !isValidPaidAt(body.paidAt)) {
      return json({ error: 'paidAt debe ser una fecha ISO válida' }, 400, cors);
    }
    paidAt = body.paidAt;
  } else {
    paidAt = new Date().toISOString();
  }

  let amountPaid: number;
  if (body.amountPaid !== undefined) {
    if (
      typeof body.amountPaid !== 'number' ||
      !isFinite(body.amountPaid) ||
      body.amountPaid <= 0
    ) {
      return json({ error: 'amountPaid debe ser un número mayor a 0' }, 400, cors);
    }
    amountPaid = body.amountPaid;
  } else {
    amountPaid = existing.amount;
  }

  const nextDue = addFrequency(existing.due_date, existing.frequency);
  const nextId = nextDue ? crypto.randomUUID() : null;

  const statements = [
    env.vence_db.prepare(
      `UPDATE bills
          SET status = 'pagada', paid_at = ?1, amount_paid = ?2, updated_at = unixepoch()
        WHERE id = ?3 AND user_id = ?4`
    ).bind(paidAt, amountPaid, billId, auth.sub),
  ];

  if (nextDue && nextId) {
    // New occurrence carries provider, amount, currency, frequency, reference.
    // Does NOT carry notes (they're usually instance-specific).
    statements.push(
      env.vence_db.prepare(
        `INSERT INTO bills
           (id, user_id, provider_id, amount, currency, due_date, frequency, status,
            reference, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pendiente', ?8, NULL, unixepoch(), unixepoch())`
      ).bind(
        nextId, auth.sub, existing.provider_id, existing.amount, existing.currency,
        nextDue, existing.frequency, existing.reference
      )
    );
  }

  await env.vence_db.batch(statements);

  const paidRow = await env.vence_db.prepare(
    `SELECT id, provider_id, amount, currency, due_date, frequency, status,
            reference, notes, paid_at, amount_paid, created_at, updated_at
       FROM bills WHERE id = ?1`
  ).bind(billId).first<BillRow>();

  let nextRow: BillRow | null = null;
  if (nextId) {
    nextRow = await env.vence_db.prepare(
      `SELECT id, provider_id, amount, currency, due_date, frequency, status,
              reference, notes, paid_at, amount_paid, created_at, updated_at
         FROM bills WHERE id = ?1`
    ).bind(nextId).first<BillRow>();
  }

  return json({
    paid: toDto(paidRow!),
    next: nextRow ? toDto(nextRow) : null,
  }, 200, cors);
}