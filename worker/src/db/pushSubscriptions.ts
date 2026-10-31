import { PUSH_LIMITS, type PushSubscriptionInfo } from '@organizador/shared';
import { sha256Hex } from '../middleware/auth';
import { fromBase64Url } from '../crypto/encoding';

/**
 * Suscripciones Web Push (`push_subscriptions`). El Worker hace POST a `endpoint`, asi que la
 * validacion (lista blanca de hosts) es la defensa contra SSRF.
 */

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  device_label: string | null;
  created_at: string;
  last_success_at: string | null;
  fail_count: number;
  last_error: string | null;
  expires_at: string | null;
}

export interface ParsedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  expiresAt: string | null;
  label: string;
}

const ENDPOINT_MAX = 2048;

/** Etiqueta del dispositivo segun el servicio push (el cliente no manda texto libre). Null = no permitido. */
export function pushServiceLabel(host: string): string | null {
  if (host === 'web.push.apple.com' || host.endsWith('.push.apple.com'))
    return 'iPhone/Mac (Apple)';
  if (host === 'fcm.googleapis.com') return 'Chrome/Edge';
  if (host === 'updates.push.services.mozilla.com') return 'Firefox';
  if (host.endsWith('.notify.windows.com')) return 'Edge Windows';
  return null;
}

/** Valida un endpoint push: https, sin credenciales ni puerto, <= 2048, host en lista blanca. */
export function validEndpoint(endpoint: unknown): URL | null {
  if (typeof endpoint !== 'string' || endpoint.length > ENDPOINT_MAX) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  // Rechaza tambien ':443' explicito (URL lo normaliza a port='').
  if (/^https:\/\/[^/?#]*:/i.test(endpoint)) return null;
  return pushServiceLabel(url.hostname) ? url : null;
}

function keyOk(s: unknown, len: number, first?: number): s is string {
  if (typeof s !== 'string' || s.length > 128) return false;
  const b = fromBase64Url(s);
  return !!b && b.length === len && (first === undefined || b[0] === first);
}

/** `PushSubscription.toJSON()` -> datos validados, o el motivo del rechazo. */
export function parseSubscription(raw: unknown): ParsedSubscription | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Body must be an object' };
  const r = raw as Record<string, unknown>;
  const url = validEndpoint(r.endpoint);
  if (!url) return { error: 'endpoint not allowed' };
  const keys = r.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys !== 'object') return { error: 'keys required' };
  if (!keyOk(keys.p256dh, 65, 0x04)) return { error: 'invalid p256dh' };
  if (!keyOk(keys.auth, 16)) return { error: 'invalid auth' };
  let expiresAt: string | null = null;
  if (r.expirationTime !== undefined && r.expirationTime !== null) {
    const t = r.expirationTime;
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > 8.64e15) {
      return { error: 'invalid expirationTime' };
    }
    expiresAt = new Date(t).toISOString();
  }
  return {
    endpoint: r.endpoint as string,
    p256dh: keys.p256dh,
    auth: keys.auth,
    expiresAt,
    label: pushServiceLabel(url.hostname) as string,
  };
}

/** Id publico estable: 16 hex de SHA-256(endpoint). El endpoint nunca sale del servidor. */
export async function subscriptionId(endpoint: string): Promise<string> {
  return (await sha256Hex(endpoint)).slice(0, 16);
}

/**
 * Alta idempotente (re-POST en cada apertura). Si cambian las claves se limpia el historial de
 * fallos. U9: tras el alta quedan como mucho `maxSubscriptions`, expulsando la de
 * `COALESCE(last_success_at, created_at)` mas antigua (nunca la recien dada de alta).
 */
export async function upsertSubscription(
  db: D1Database,
  s: ParsedSubscription,
  nowIso: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_label, created_at, fail_count, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
         ON CONFLICT(endpoint) DO UPDATE SET
           fail_count = CASE WHEN p256dh = excluded.p256dh AND auth = excluded.auth THEN fail_count ELSE 0 END,
           last_error = CASE WHEN p256dh = excluded.p256dh AND auth = excluded.auth THEN last_error ELSE NULL END,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           device_label = excluded.device_label,
           expires_at = excluded.expires_at`,
      )
      .bind(s.endpoint, s.p256dh, s.auth, s.label, nowIso, s.expiresAt),
    db
      .prepare(
        `DELETE FROM push_subscriptions WHERE endpoint IN (
           SELECT endpoint FROM push_subscriptions WHERE endpoint != ?1
           ORDER BY COALESCE(last_success_at, created_at) DESC, created_at DESC
           LIMIT -1 OFFSET ?2)`,
      )
      .bind(s.endpoint, PUSH_LIMITS.maxSubscriptions - 1),
  ]);
}

/** Todas las suscripciones (como mucho `maxSubscriptions`), mas reciente primero. */
export async function listSubscriptions(db: D1Database): Promise<StoredSubscription[]> {
  const { results } = await db
    .prepare('SELECT * FROM push_subscriptions ORDER BY created_at DESC')
    .all<StoredSubscription>();
  return results;
}

/** Suscripciones a las que se puede enviar (sin caducar). */
export async function listActive(db: D1Database, nowMs: number): Promise<StoredSubscription[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM push_subscriptions WHERE expires_at IS NULL OR expires_at > ?1 ORDER BY created_at DESC',
    )
    .bind(new Date(nowMs).toISOString())
    .all<StoredSubscription>();
  return results;
}

/** Borra las suscripciones caducadas (expires_at <= ahora); devuelve cuantas. */
export async function purgeExpired(db: D1Database, nowMs: number): Promise<number> {
  const r = await db
    .prepare('DELETE FROM push_subscriptions WHERE expires_at IS NOT NULL AND expires_at <= ?1')
    .bind(new Date(nowMs).toISOString())
    .run();
  return r.meta.changes ?? 0;
}

export async function deleteByEndpoint(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint).run();
}

/** Borra por id publico (Ajustes > Quitar otro dispositivo). D1 no tiene SHA-256: se recorre (<= 5 filas). */
export async function deleteById(db: D1Database, id: string): Promise<void> {
  for (const s of await listSubscriptions(db)) {
    if ((await subscriptionId(s.endpoint)) === id) await deleteByEndpoint(db, s.endpoint);
  }
}

export async function toSubscriptionInfo(s: StoredSubscription): Promise<PushSubscriptionInfo> {
  return {
    id: await subscriptionId(s.endpoint),
    label: s.device_label ?? 'Dispositivo',
    createdAt: s.created_at,
    lastOkAt: s.last_success_at,
    failCount: s.fail_count,
    lastError: s.last_error,
  };
}

/** Resultado de un envio segun la tabla 2.2 del plan. */
export type PushOutcome = { kind: 'ok' } | { kind: 'gone' } | { kind: 'error'; code: string };

/** Clasifica la respuesta del servicio push (`'network'` = fetch lanzo). */
export function classifyPushResponse(status: number | 'network'): PushOutcome {
  if (status === 'network') return { kind: 'error', code: 'retry_network' };
  if (status >= 200 && status < 300) return { kind: 'ok' };
  if (status === 404 || status === 410) return { kind: 'gone' };
  if (status === 413) return { kind: 'error', code: 'payload_too_large' };
  if (status === 429 || status >= 500 || (status >= 300 && status < 400)) {
    return { kind: 'error', code: `retry_${status}` };
  }
  // 400/401/403 (BadJwtToken, VapidPkHashMismatch...): configuracion VAPID, no del dispositivo.
  return { kind: 'error', code: `rejected_${status}` };
}

/** Aplica el resultado a la fila: exito resetea, 404/410 borra, el resto cuenta un fallo. */
export async function markResult(
  db: D1Database,
  endpoint: string,
  outcome: PushOutcome,
  nowIso: string,
): Promise<void> {
  if (outcome.kind === 'gone') return deleteByEndpoint(db, endpoint);
  const stmt =
    outcome.kind === 'ok'
      ? db
          .prepare(
            'UPDATE push_subscriptions SET last_success_at = ?2, fail_count = 0, last_error = NULL WHERE endpoint = ?1',
          )
          .bind(endpoint, nowIso)
      : db
          .prepare(
            'UPDATE push_subscriptions SET fail_count = fail_count + 1, last_error = ?2 WHERE endpoint = ?1',
          )
          .bind(endpoint, outcome.code);
  await stmt.run();
}
