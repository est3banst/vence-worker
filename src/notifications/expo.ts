import type { Env } from '../env';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const MAX_PER_REQUEST = 100; // Expo's documented batch ceiling
const MAX_RECEIPTS_PER_REQUEST = 1000; // Expo's documented receipt ceiling

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Android notification channel; must exist on the device. */
  channelId?: string;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoReceipt {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/** A ticket id paired with the token it was issued for. */
export interface Ticket {
  id: string;
  token: string;
}

export interface SendResult {
  /** Messages Expo *accepted*. Acceptance is not delivery — see checkReceipts. */
  sent: number;
  /** Tokens Expo says are dead — caller should disable them. */
  deadTokens: string[];
  errors: string[];
  /** Accepted messages, for the receipt check that reveals delivery failures. */
  tickets: Ticket[];
}

export interface ReceiptResult {
  delivered: number;
  /** Tokens the transport rejected — caller should disable them. */
  deadTokens: string[];
  errors: string[];
  /** Receipts Expo has not decided yet; neither success nor failure. */
  pending: number;
}

/**
 * Pause before asking Expo for a receipt.
 *
 * `PUSH_RECEIPT_WAIT_MS` overrides the caller's figure — the test env sets it
 * to 0 so the suite doesn't spend real seconds waiting on a stubbed fetch.
 */
export function receiptWait(env: Env, fallbackMs: number): Promise<void> {
  const raw = env.PUSH_RECEIPT_WAIT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  const ms = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Shared between send and receipt calls. */
function pushHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
  };
  // Optional, but Expo recommends it and enforces it once you enable
  // "Enhanced Security for Push Notifications" on the project.
  if (env.EXPO_ACCESS_TOKEN) {
    headers['Authorization'] = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
  }
  return headers;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Send through Expo's push service.
 *
 * Expo answers with one ticket per message, in order. A `DeviceNotRegistered`
 * error means the app was uninstalled or the token rotated, so we hand those
 * tokens back to be disabled.
 *
 * An `ok` ticket means Expo accepted the message, NOT that it arrived: APNs and
 * FCM rejections (a stale registration, mismatched credentials) surface only in
 * the receipt. So the accepted tickets come back with the result, and the
 * caller passes them to `checkReceipts` to learn what actually happened.
 */
export async function sendPush(env: Env, messages: PushMessage[]): Promise<SendResult> {
  const result: SendResult = { sent: 0, deadTokens: [], errors: [], tickets: [] };
  if (messages.length === 0) return result;

  for (const batch of chunk(messages, MAX_PER_REQUEST)) {
    const headers = pushHeaders(env);

    let resp: Response;
    try {
      resp = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(batch),
      });
    } catch (err) {
      result.errors.push(`network: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!resp.ok) {
      result.errors.push(`expo ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
      continue;
    }

    const payload = await resp.json().catch(() => null) as { data?: ExpoTicket[] } | null;
    const tickets = payload?.data ?? [];

    tickets.forEach((ticket, i) => {
      const accepted = batch[i]?.to;
      if (ticket.status === 'ok') {
        result.sent++;
        if (ticket.id && accepted) result.tickets.push({ id: ticket.id, token: accepted });
        return;
      }
      const token = batch[i]?.to;
      if (ticket.details?.error === 'DeviceNotRegistered' && token) {
        result.deadTokens.push(token);
      } else {
        result.errors.push(ticket.message ?? 'unknown expo error');
      }
    });
  }

  return result;
}

/**
 * Ask Expo what became of accepted messages.
 *
 * This is the only place a transport-level failure is visible. The classic one
 * is a ticket that came back `ok` and a receipt that says
 * `DeviceNotRegistered` — the token was issued by an install that no longer
 * exists (an uninstall or a reinstall invalidates the FCM registration), or the
 * credentials the app was built with don't match the ones the sender uses. Any
 * such token will fail forever, so it is handed back to be disabled.
 *
 * A receipt Expo has not decided yet simply isn't in the response. Those count
 * as `pending` rather than as failures: absence of a receipt is not bad news.
 */
export async function checkReceipts(env: Env, tickets: Ticket[]): Promise<ReceiptResult> {
  const result: ReceiptResult = { delivered: 0, deadTokens: [], errors: [], pending: 0 };
  if (tickets.length === 0) return result;

  const tokenById = new Map(tickets.map(t => [t.id, t.token]));

  for (const batch of chunk(tickets, MAX_RECEIPTS_PER_REQUEST)) {
    let resp: Response;
    try {
      resp = await fetch(EXPO_RECEIPT_URL, {
        method: 'POST',
        headers: pushHeaders(env),
        body: JSON.stringify({ ids: batch.map(t => t.id) }),
      });
    } catch (err) {
      result.errors.push(`receipts network: ${err instanceof Error ? err.message : String(err)}`);
      result.pending += batch.length;
      continue;
    }

    if (!resp.ok) {
      result.errors.push(`receipts ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
      result.pending += batch.length;
      continue;
    }

    const payload = await resp.json().catch(() => null) as { data?: Record<string, ExpoReceipt> } | null;
    const receipts = payload?.data ?? {};

    for (const { id } of batch) {
      const receipt = receipts[id];
      if (!receipt) {
        result.pending++;
        continue;
      }
      if (receipt.status === 'ok') {
        result.delivered++;
        continue;
      }
      const token = tokenById.get(id);
      // DeviceNotRegistered is permanent; everything else may be transient, so
      // only the former costs the token its registration.
      if (receipt.details?.error === 'DeviceNotRegistered' && token) {
        result.deadTokens.push(token);
      }
      result.errors.push(receipt.message ?? `receipt error for ${id}`);
    }
  }

  return result;
}
