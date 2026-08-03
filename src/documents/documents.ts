import type { Env } from '../env';
import { json, sanitizeFilename } from '../helpers/helpers'
import type { AuthContext } from '../auth';
import { ALLOWED_MIME, MAX_FILE_SIZE, PDF_MAGIC } from '../helpers/constants';

export async function uploadDocument(
  req: Request,
  env: Env,
  auth: AuthContext,
  billId: string,
  cors: Record<string, string>
): Promise<Response> {
  const contentType = (req.headers.get('Content-Type') || '').split(';')[0].trim();
  if (contentType !== ALLOWED_MIME) {
    return json({ error: 'Solo se permiten archivos PDF' }, 415, cors);
  }

  const declared = Number(req.headers.get('Content-Length') || 0);
  if (declared && declared > MAX_FILE_SIZE) {
    return json({ error: 'El archivo supera el tamaño máximo (2 MB)' }, 413, cors);
  }

  const body = await req.arrayBuffer();
  if (body.byteLength === 0) {
    return json({ error: 'Archivo vacío' }, 400, cors);
  }
  if (body.byteLength > MAX_FILE_SIZE) {
    return json({ error: 'El archivo supera el tamaño máximo (2 MB)' }, 413, cors);
  }

  const head = new TextDecoder().decode(new Uint8Array(body, 0, 5));
  if (head !== PDF_MAGIC) {
    return json({ error: 'El archivo no es un PDF válido' }, 400, cors);
  }

  const filename = sanitizeFilename(req.headers.get('X-Filename'));
  const docId = crypto.randomUUID();
  const r2Key = `users/${auth.sub}/bills/${billId}/${docId}.pdf`;
  const uploadedAt = new Date().toISOString();

  // R2 first.
  await env.BILLS_BUCKET.put(r2Key, body, {
    httpMetadata: { contentType: ALLOWED_MIME },
    customMetadata: { userId: auth.sub, billId, filename, uploadedAt },
  });

  // Then D1. If insert fails, roll back the R2 object to avoid orphans.
  try {
    await env.vence_db.prepare(
      `INSERT INTO documents
         (id, user_id, bill_id, r2_key, filename, size, content_type, uploaded_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
      .bind(docId, auth.sub, billId, r2Key, filename, body.byteLength, ALLOWED_MIME, uploadedAt)
      .run();
  } catch (err) {
    await env.BILLS_BUCKET.delete(r2Key).catch(() => {});
    throw err;
  }

  return json(
    { id: docId, billId, filename, size: body.byteLength, uploadedAt },
    201,
    cors
  );
}

export async function listDocuments(
  env: Env,
  auth: AuthContext,
  billId: string,
  cors: Record<string, string>
): Promise<Response> {
  const result = await env.vence_db.prepare(
    `SELECT id, filename, size, uploaded_at
       FROM documents
      WHERE user_id = ?1 AND bill_id = ?2
   ORDER BY uploaded_at DESC`
  )
    .bind(auth.sub, billId)
    .all<{ id: string; filename: string; size: number; uploaded_at: string }>();

  return json(
    {
      documents: (result.results ?? []).map((r) => ({
        id: r.id,
        filename: r.filename,
        size: r.size,
        uploadedAt: r.uploaded_at,
      })),
    },
    200,
    cors
  );
}

export async function downloadDocument(
  env: Env,
  auth: AuthContext,
  docId: string,
  cors: Record<string, string>
): Promise<Response> {
  const row = await env.vence_db.prepare(
    `SELECT r2_key, filename, content_type, size
       FROM documents
      WHERE id = ?1 AND user_id = ?2`
  )
    .bind(docId, auth.sub)
    .first<{ r2_key: string; filename: string; content_type: string; size: number }>();

  if (!row) {
    return json({ error: 'Documento no encontrado' }, 404, cors);
  }

  const object = await env.BILLS_BUCKET.get(row.r2_key);
  if (!object) {
    // D1 has it but R2 doesn't — log; treat as 404 from the user's perspective.
    console.error('R2 object missing for document', { docId, r2_key: row.r2_key });
    return json({ error: 'Archivo no encontrado en almacenamiento' }, 404, cors);
  }

  const headers = new Headers(cors);
  headers.set('Content-Type', row.content_type);
  headers.set('Content-Length', row.size.toString());
  headers.set(
    'Content-Disposition',
    `inline; filename="${row.filename.replace(/"/g, '')}"`
  );
  headers.set('Cache-Control', 'private, max-age=0, must-revalidate');
  return new Response(object.body, { headers });
}

export async function deleteDocument(
  env: Env,
  auth: AuthContext,
  docId: string,
  cors: Record<string, string>
): Promise<Response> {
  const row = await env.vence_db.prepare(
    `SELECT r2_key FROM documents WHERE id = ?1 AND user_id = ?2`
  )
    .bind(docId, auth.sub)
    .first<{ r2_key: string }>();

  if (!row) {
    return json({ error: 'Documento no encontrado' }, 404, cors);
  }

  await env.BILLS_BUCKET.delete(row.r2_key);
  await env.vence_db.prepare(
    `DELETE FROM documents WHERE id = ?1 AND user_id = ?2`
  )
    .bind(docId, auth.sub)
    .run();

  return json({ deleted: true, id: docId }, 200, cors);
}

interface DocumentWithBillRow {
  id: string;
  bill_id: string;
  filename: string;
  size: number;
  uploaded_at: string;
  bill_due_date: string;
  bill_amount: number;
  bill_currency: string;
  provider_name: string | null;
}

interface DocumentListItem {
  id: string;
  billId: string;
  filename: string;
  size: number;
  uploadedAt: string;
  bill: {
    dueDate: string;
    amount: number;
    currency: string;
    providerName: string | null;
  };
}

/**
 * List documents for the current user, filtered by month.
 * Query: ?year=YYYY&month=MM (both required, 1-12).
 * Returns documents joined with bill+provider so the UI can render meaningfully
 * without a second round-trip per document.
 */
export async function listDocumentsByMonth(
  req: Request,
  env: Env,
  auth: AuthContext,
  cors: Record<string, string>
): Promise<Response> {
  const url = new URL(req.url);
  const yearParam = url.searchParams.get('year');
  const monthParam = url.searchParams.get('month');

  if (!yearParam || !monthParam) {
    return json({ error: 'year y month son requeridos' }, 400, cors);
  }
  const year = Number(yearParam);
  const month = Number(monthParam);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return json({ error: 'year inválido' }, 400, cors);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return json({ error: 'month debe estar entre 1 y 12' }, 400, cors);
  }

  // Month bounds in UTC. end is exclusive so uploaded_at < end.
  const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);

  const result = await env.vence_db.prepare(
    `SELECT
        d.id, d.bill_id, d.filename, d.size, d.uploaded_at,
        b.due_date AS bill_due_date,
        b.amount   AS bill_amount,
        b.currency AS bill_currency,
        p.name     AS provider_name
       FROM documents d
       LEFT JOIN bills     b ON b.id = d.bill_id
       LEFT JOIN providers p ON p.id = b.provider_id
      WHERE d.user_id = ?1
        AND d.deleted_at IS NULL
        AND date(d.uploaded_at) >= date(?2)
        AND date(d.uploaded_at) < date(?3)
      ORDER BY d.uploaded_at DESC`
  ).bind(auth.sub, start, end).all<DocumentWithBillRow>();

  const documents: DocumentListItem[] = (result.results ?? []).map(row => ({
    id: row.id,
    billId: row.bill_id,
    filename: row.filename,
    size: row.size,
    uploadedAt: row.uploaded_at,
    bill: {
      dueDate: row.bill_due_date,
      amount: row.bill_amount,
      currency: row.bill_currency,
      providerName: row.provider_name,
    },
  }));

  return json({ year, month, documents }, 200, cors);
}