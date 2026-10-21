import type { Env } from '../env';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_PER_REQUEST = 100; // Expo's documented batch ceiling

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

export interface SendResult {
  sent: number;
  /** Tokens Expo says are dead — caller should disable them. */
  deadTokens: string[];
  errors: string[];
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
 * Note: Expo also exposes a receipts endpoint for delivery errors that only
 * surface later (APNs/FCM rejections). We only read the immediate tickets here;
 * polling receipts would need somewhere to park ticket ids between cron runs.
 */
export async function sendPush(env: Env, messages: PushMessage[]): Promise<SendResult> {
  const result: SendResult = { sent: 0, deadTokens: [], errors: [] };
  if (messages.length === 0) return result;

  for (const batch of chunk(messages, MAX_PER_REQUEST)) {
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
      if (ticket.status === 'ok') {
        result.sent++;
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
