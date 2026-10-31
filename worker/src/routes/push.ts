import {
  formatDateInTz,
  PUSH_LIMITS,
  type DigestInfo,
  type DigestStatus,
  type PushStatusResponse,
} from '@organizador/shared';
import { Hono, type Context } from 'hono';
import { now } from '../clock';
import {
  deleteByEndpoint,
  deleteById,
  listSubscriptions,
  parseSubscription,
  subscriptionId,
  toSubscriptionInfo,
  upsertSubscription,
} from '../db/pushSubscriptions';
import type { AppEnv } from '../env';
import { errorBody } from '../errors';
import { buildDigest } from '../jobs/digest';
import { loadDigestInputs, NOTIFY_TTL_S } from '../jobs/notify';
import { sendToAll, vapidSubject } from '../push/send';
import { parseVapidKey } from '../push/webpush';
import { DEFAULT_TZ } from '../sync/window';

/** `/api/push/*` (Bearer o sesion via el middleware de /api/*). */
export const push = new Hono<AppEnv>();

/** Un PushSubscription.toJSON() ocupa < 1 KB (endpoint <= 2048). */
const BODY_MAX = 4096;
const ID_RE = /^[0-9a-f]{16}$/;

push.use('/api/push/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

const notConfigured = (c: Context<AppEnv>) =>
  c.json(errorBody('push_not_configured', 'Push is not configured'), 503);

/** JSON del cuerpo con limite de tamano; Response si no es valido. */
async function readBody(c: Context<AppEnv>): Promise<unknown | Response> {
  if (Number(c.req.header('Content-Length') ?? 0) > BODY_MAX) {
    return c.json(errorBody('payload_too_large', 'Body too large'), 413);
  }
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > BODY_MAX)
    return c.json(errorBody('payload_too_large', 'Body too large'), 413);
  try {
    return JSON.parse(new TextDecoder().decode(buf)) as unknown;
  } catch {
    return c.json(errorBody('validation', 'Body must be JSON'), 400);
  }
}

push.get('/api/push/status', async (c) => {
  const key = parseVapidKey(c.env.VAPID_PRIVATE_KEY);
  const db = c.env.DB;
  const today = formatDateInTz(new Date(now()), c.env.TZ);
  const [subs, row] = await Promise.all([
    listSubscriptions(db),
    db
      .prepare('SELECT date, status, attempts, last_error, sent_at FROM digest_log WHERE date = ?1')
      .bind(today)
      .first<{
        date: string;
        status: DigestStatus;
        attempts: number;
        last_error: string | null;
        sent_at: string | null;
      }>(),
  ]);
  const digest: DigestInfo | null = row
    ? {
        date: row.date,
        status: row.status,
        attempts: row.attempts,
        lastError: row.last_error,
        sentAt: row.sent_at,
      }
    : null;
  const body: PushStatusResponse = {
    configured: key !== null,
    publicKey: key?.publicKey ?? null,
    subject: vapidSubject(c.env),
    subscriptions: await Promise.all(subs.map(toSubscriptionInfo)),
    digest,
  };
  return c.json(body);
});

push.post('/api/push/subscribe', async (c) => {
  if (!parseVapidKey(c.env.VAPID_PRIVATE_KEY)) return notConfigured(c);
  const raw = await readBody(c);
  if (raw instanceof Response) return raw;
  const parsed = parseSubscription(raw);
  if ('error' in parsed) return c.json(errorBody('validation', parsed.error), 400);
  await upsertSubscription(c.env.DB, parsed, new Date(now()).toISOString());
  return c.json({ id: await subscriptionId(parsed.endpoint) });
});

// Idempotente: `?id=<id>` (quitar otro dispositivo) o body `{ endpoint }` (este dispositivo).
push.delete('/api/push/subscribe', async (c) => {
  const id = c.req.query('id');
  if (id !== undefined) {
    if (!ID_RE.test(id)) return c.json(errorBody('validation', 'invalid id'), 400);
    await deleteById(c.env.DB, id);
    return c.body(null, 204);
  }
  const raw = await readBody(c);
  if (raw instanceof Response) return raw;
  const endpoint = (raw as { endpoint?: unknown } | null)?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 2048) {
    return c.json(errorBody('validation', 'endpoint or id required'), 400);
  }
  await deleteByEndpoint(c.env.DB, endpoint);
  return c.body(null, 204);
});

/** Mismo UPSERT atomico que /api/sync: solo un envio manual por `key` cada testIntervalMs. */
async function throttled(c: Context<AppEnv>, key: string, nowMs: number): Promise<Response | null> {
  const r = await c.env.DB.prepare(
    `INSERT INTO job_state (key, value, updated_at) VALUES (?3, '1', ?1)
     ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at
     WHERE job_state.updated_at <= ?2`,
  )
    .bind(
      new Date(nowMs).toISOString(),
      new Date(nowMs - PUSH_LIMITS.testIntervalMs).toISOString(),
      key,
    )
    .run();
  if (r.meta.changes === 1) return null;
  c.header('Retry-After', String(PUSH_LIMITS.testIntervalMs / 1000));
  return c.json(errorBody('rate_limited', 'Test push was requested recently'), 429);
}

// Resumen de hoy+manana ya, para probarlo sin esperar a las 8:00. No escribe digest_log,
// reminder_log ni notify_lock (el resumen real sale igual) y comparte tag con el real.
push.post('/api/push/digest-now', async (c) => {
  if (!parseVapidKey(c.env.VAPID_PRIVATE_KEY)) return notConfigured(c);
  const nowMs = now();
  const limited = await throttled(c, 'push_digest_now_at', nowMs);
  if (limited) return limited;
  const tz = c.env.TZ || DEFAULT_TZ;
  const today = formatDateInTz(new Date(nowMs), tz);
  const d = await loadDigestInputs(c.env.DB, today, nowMs, tz);
  const content = buildDigest(d.todayEvents, d.tomorrowEvents, d.quickNotesCount, tz, today);
  const result = await sendToAll(
    c.env,
    { v: 1, ...content },
    { ttl: NOTIFY_TTL_S, urgency: 'high', topic: 'digest' },
  );
  return result ? c.json(result) : notConfigured(c);
});

push.post('/api/push/test', async (c) => {
  if (!parseVapidKey(c.env.VAPID_PRIVATE_KEY)) return notConfigured(c);
  const limited = await throttled(c, 'push_test_at', now());
  if (limited) return limited;
  const result = await sendToAll(
    c.env,
    {
      v: 1,
      title: 'Notificación de prueba',
      body: 'Las notificaciones funcionan.',
      url: '#/hoy',
      tag: 'test',
    },
    { ttl: 60, urgency: 'normal' },
  );
  return result ? c.json(result) : notConfigured(c);
});
