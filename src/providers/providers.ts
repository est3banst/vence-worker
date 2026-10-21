import type { Env } from '../env';
import type { AuthContext } from '../auth';
import { json } from '../helpers/helpers';

const VALID_CATEGORIES = [
  'servicios', 'internet', 'suscripcion', 'profesional',
  'impuesto', 'alquiler', 'tarjeta', 'seguro', 'patente', 'otro',
] as const;

interface ProviderRow {
  id: string;
  name: string;
  category: string;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

function toDto(row: ProviderRow) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    notes: row.notes ?? undefined,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
  };
}

export async function createProvider(
  req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return json({ error: 'Body inválido' }, 400, cors);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const category = typeof body.category === 'string' ? body.category : '';
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;

  if (!name || name.length > 200) {
    return json({ error: 'name requerido (1-200 caracteres)' }, 400, cors);
  }
  if (!(VALID_CATEGORIES as readonly string[]).includes(category)) {
    return json({ error: `category inválida (valores: ${VALID_CATEGORIES.join(', ')})` }, 400, cors);
  }
  if (notes && notes.length > 2000) {
    return json({ error: 'notes muy largo (máx 2000 caracteres)' }, 400, cors);
  }

  const id = crypto.randomUUID();

  await env.vence_db.prepare(
    `INSERT INTO providers (id, user_id, name, category, notes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, unixepoch(), unixepoch())`
  )
    .bind(id, auth.sub, name, category, notes)
    .run();

  const row = await env.vence_db.prepare(
    `SELECT id, name, category, notes, created_at, updated_at
       FROM providers WHERE id = ?1`
  ).bind(id).first<ProviderRow>();

  return json(toDto(row!), 201, cors);
}

export async function listProviders(
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const result = await env.vence_db.prepare(
    `SELECT id, name, category, notes, created_at, updated_at
       FROM providers
      WHERE user_id = ?1 AND deleted_at IS NULL
      ORDER BY name COLLATE NOCASE`
  ).bind(auth.sub).all<ProviderRow>();

  return json({ providers: (result.results ?? []).map(toDto) }, 200, cors);
}

export async function updateProvider(
  req: Request,
  env: Env,
  auth: AuthContext,
  providerId: string,
  cors: Record<string, string>
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return json({ error: 'Body inválido' }, 400, cors);
  }

  const existing = await env.vence_db.prepare(
    `SELECT id, name, category, notes, created_at, updated_at
       FROM providers
      WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`
  ).bind(providerId, auth.sub).first<ProviderRow>();

  if (!existing) {
    return json({ error: 'Proveedor no encontrado' }, 404, cors);
  }

  // Apply patches. Each field: undefined = keep, null/"" for notes = clear.
  let name = existing.name;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      return json({ error: 'name debe ser texto' }, 400, cors);
    }
    const trimmed = body.name.trim();
    if (!trimmed || trimmed.length > 200) {
      return json({ error: 'name debe tener entre 1 y 200 caracteres' }, 400, cors);
    }
    name = trimmed;
  }

  let category = existing.category;
  if (body.category !== undefined) {
    if (
      typeof body.category !== 'string' ||
      !(VALID_CATEGORIES as readonly string[]).includes(body.category)
    ) {
      return json(
        { error: `category inválida (valores: ${VALID_CATEGORIES.join(', ')})` },
        400,
        cors
      );
    }
    category = body.category;
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

  await env.vence_db.prepare(
    `UPDATE providers
        SET name = ?1, category = ?2, notes = ?3, updated_at = unixepoch()
      WHERE id = ?4 AND user_id = ?5`
  ).bind(name, category, notes, providerId, auth.sub).run();

  const updated = await env.vence_db.prepare(
    `SELECT id, name, category, notes, created_at, updated_at
       FROM providers WHERE id = ?1`
  ).bind(providerId).first<ProviderRow>();

  return json(toDto(updated!), 200, cors);
}

export async function deleteProvider(
  env: Env,
  auth: AuthContext,
  providerId: string,
  cors: Record<string, string>
): Promise<Response> {
  // Soft-delete the provider AND cascade soft-delete its non-deleted bills.
  // D1 batch runs atomically — either both updates land or neither does.
  const results = await env.vence_db.batch([
    env.vence_db.prepare(
      `UPDATE providers
          SET deleted_at = unixepoch(), updated_at = unixepoch()
        WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`
    ).bind(providerId, auth.sub),
    env.vence_db.prepare(
      `UPDATE bills
          SET deleted_at = unixepoch(), updated_at = unixepoch()
        WHERE provider_id = ?1 AND user_id = ?2 AND deleted_at IS NULL`
    ).bind(providerId, auth.sub),
  ]);

  if ((results[0].meta?.changes ?? 0) === 0) {
    return json({ error: 'Proveedor no encontrado' }, 404, cors);
  }

  return json(
    {
      deleted: true,
      id: providerId,
      billsAffected: results[1].meta?.changes ?? 0,
    },
    200,
    cors
  );
}