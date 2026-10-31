import { addDaysToDateStr, formatDateInTz, type DigestStatus } from '@organizador/shared';
import { dueReminders, listEventsInRange, listRemindCandidates } from '../db/eventsRead';
import { acquireLock, releaseLock } from '../db/jobLock';
import { listLiveNotes } from '../db/notes';
import { listActive } from '../db/pushSubscriptions';
import type { Env } from '../env';
import { sendToAll } from '../push/send';
import type { PushRequestOptions } from '../push/webpush';
import { DEFAULT_TZ } from '../sync/window';
import { buildDigest, buildReminders, type PushContent, type ReminderItem } from './digest';

/**
 * Paso `notify` del cron (T4.4 + T4.6): resumen de las 8:00 (D4) y avisos D-N (D5).
 * - Decision por hora LOCAL (Europe/Madrid via Intl): en verano cae a las 06:00 UTC, en invierno a las 07:00.
 * - Ventana [08:00, 12:00): reintento en cada cron; a las 12:00 `gave_up` (sin fila = `missed_window`).
 * - Sin nada que hacer: solo lecturas (ni lock). Con trabajo: lock `notify_lock` y relectura dentro.
 * - Avisos: despues del resumen, un push agrupado (U4); `reminder_log` solo tras >= 1 entrega
 *   (fallo = sin log = reintento en el siguiente cron/dia mientras siga en rango).
 * Payload: solo horas y titulos (nunca notes, description, location ni texto de notas rapidas).
 */

export const NOTIFY_LOCK_KEY = 'notify_lock';
export const NOTIFY_LOCK_TTL_MS = 5 * 60_000;
/** TTL de resumen y avisos (2.1): 4 h. */
export const NOTIFY_TTL_S = 4 * 3600;
export const DIGEST_FROM_HOUR = 8;
export const DIGEST_UNTIL_HOUR = 12;
/** Horizonte de candidatos a aviso (2.6): [manana, hoy+60]. */
export const REMIND_HORIZON_DAYS = 60;

/**
 * Tope de intentos escritos del resumen. El intento se anota ANTES de enviar, asi que un corte por
 * CPU a mitad del cifrado tambien cuenta: tras 6 intentos (de ~24 crons en la ventana) se abandona.
 */
export const DIGEST_MAX_ATTEMPTS = 6;

export type DigestAction = 'wait' | 'send' | 'give_up' | 'done';

interface DigestRow {
  status: DigestStatus;
  attempts: number;
  last_error: string | null;
}

/** Planificador puro del resumen (2.4). */
export function digestAction(
  hour: number,
  row: { status: DigestStatus; attempts?: number } | null,
): DigestAction {
  if (hour < DIGEST_FROM_HOUR) return 'wait';
  if (row && row.status !== 'pending' && row.status !== 'failed') return 'done';
  if (row && (row.attempts ?? 0) >= DIGEST_MAX_ATTEMPTS) return 'give_up';
  return hour < DIGEST_UNTIL_HOUR ? 'send' : 'give_up';
}

export function localHour(nowMs: number, tz: string): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(
      new Date(nowMs),
    ),
  );
}

/** Datos del resumen (compartido con `GET /api/digest`). */
export async function loadDigestInputs(db: D1Database, today: string, nowMs: number, tz: string) {
  const tomorrow = addDaysToDateStr(today, 1);
  const opts = { nowMs, tz };
  const [todayEvents, tomorrowEvents, notes] = await Promise.all([
    listEventsInRange(db, today, today, opts),
    listEventsInRange(db, tomorrow, tomorrow, opts),
    listLiveNotes(db, nowMs, 'quick'),
  ]);
  return { todayEvents, tomorrowEvents, quickNotesCount: notes.length };
}

export interface NotifyResult {
  status: 'idle' | 'busy' | 'ok';
  /** Peticiones push hechas (cota superior). */
  requests: number;
  digest: DigestAction | DigestStatus | 'no_budget' | null;
  reminders: number;
}

const startKey = (r: ReminderItem) => (r.startAt ?? r.startDate)!;
const logKey = (c: string, e: string, s: string) => `${c}\u0000${e}\u0000${s}`;

/** Avisos que tocan hoy y aun no tienen `reminder_log` 'sent'. */
async function pendingReminders(
  db: D1Database,
  today: string,
  nowMs: number,
  tz: string,
): Promise<ReminderItem[]> {
  const candidates = await listRemindCandidates(
    db,
    addDaysToDateStr(today, 1),
    addDaysToDateStr(today, REMIND_HORIZON_DAYS),
    { nowMs, tz },
  );
  const due = dueReminders(candidates, today, tz);
  if (due.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT calendar_id, event_id, start_key FROM reminder_log WHERE status = 'sent'`)
    .all<{ calendar_id: string; event_id: string; start_key: string }>();
  const sent = new Set(results.map((r) => logKey(r.calendar_id, r.event_id, r.start_key)));
  return due
    .map(({ event: e, inDays }) => ({
      calendarId: e.calendarId,
      id: e.id,
      summary: e.summary ?? null,
      allDay: e.allDay,
      startAt: e.startAt ?? null,
      startDate: e.startDate ?? null,
      inDays,
    }))
    .filter((r) => !sent.has(logKey(r.calendarId, r.id, startKey(r))));
}

async function plan(env: Env, today: string, hour: number, nowMs: number, tz: string) {
  const row = await env.DB.prepare(
    'SELECT status, attempts, last_error FROM digest_log WHERE date = ?1',
  )
    .bind(today)
    .first<DigestRow>();
  const action = digestAction(hour, row);
  const reminders =
    hour < DIGEST_UNTIL_HOUR ? await pendingReminders(env.DB, today, nowMs, tz) : [];
  return { row, action, reminders };
}

async function writeDigest(
  db: D1Database,
  date: string,
  status: DigestStatus,
  o: { attempt: boolean; error: string | null; nowIso: string },
) {
  await db
    .prepare(
      `INSERT INTO digest_log (date, status, attempts, last_error, last_attempt_at, sent_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(date) DO UPDATE SET status = excluded.status,
         attempts = digest_log.attempts + excluded.attempts, last_error = excluded.last_error,
         last_attempt_at = COALESCE(excluded.last_attempt_at, digest_log.last_attempt_at),
         sent_at = excluded.sent_at,
         acknowledged = CASE WHEN excluded.status = 'gave_up' AND digest_log.status != 'gave_up'
           THEN 0 ELSE digest_log.acknowledged END`,
    )
    .bind(
      date,
      status,
      o.attempt ? 1 : 0,
      o.error,
      o.attempt ? o.nowIso : null,
      status === 'sent' ? o.nowIso : null,
    )
    .run();
}

/** Anota el intento ANTES de enviar (conserva status y last_error previos). */
async function recordAttempt(db: D1Database, date: string, nowIso: string) {
  await db
    .prepare(
      `INSERT INTO digest_log (date, status, attempts, last_attempt_at) VALUES (?1, 'pending', 1, ?2)
       ON CONFLICT(date) DO UPDATE SET attempts = digest_log.attempts + 1, last_attempt_at = ?2`,
    )
    .bind(date, nowIso)
    .run();
}

/** Codigo agregado de un envio sin entregas, de los resultados de esta ejecucion. */
const failCode = (removedOnly: boolean, lastError: string | undefined) =>
  removedOnly ? 'all_failed:gone' : lastError ? `all_failed:${lastError}` : 'all_failed';

const message = (c: PushContent) => ({ v: 1 as const, ...c });

/**
 * Ejecuta el paso. `budget`: subrequests disponibles; cada push reserva una por suscripcion
 * (si no llegan, espera al siguiente cron).
 */
export async function runNotify(env: Env, nowMs: number, budget = Infinity): Promise<NotifyResult> {
  const res: NotifyResult = { status: 'idle', requests: 0, digest: null, reminders: 0 };
  const tz = env.TZ || DEFAULT_TZ;
  const hour = localHour(nowMs, tz);
  if (hour < DIGEST_FROM_HOUR) return res;
  const today = formatDateInTz(new Date(nowMs), tz);
  const pre = await plan(env, today, hour, nowMs, tz);
  if (pre.action === 'done' && pre.reminders.length === 0) return res;

  const lock = await acquireLock(env.DB, NOTIFY_LOCK_KEY, NOTIFY_LOCK_TTL_MS, nowMs);
  if (!lock) return { ...res, status: 'busy' };
  res.status = 'ok';
  try {
    const p = await plan(env, today, hour, nowMs, tz);
    const nowIso = new Date(nowMs).toISOString();
    res.digest = p.action;
    const nSubs = (await listActive(env.DB, nowMs)).length;
    const send = async (c: PushContent, extra: Pick<PushRequestOptions, 'topic'>) => {
      let lastError: string | undefined;
      const r = await sendToAll(env, message(c), {
        ttl: NOTIFY_TTL_S,
        urgency: 'high',
        ...extra,
        maxSends: budget - res.requests,
        onError: (code) => (lastError = code),
      });
      if (r) res.requests += r.sent + r.failed + r.removed;
      return { r, lastError };
    };
    const fits = () => nSubs > 0 && budget - res.requests >= nSubs;

    if (p.action === 'give_up') {
      // Sin suscripciones y sin intentos previos no hay nada que perder: sin banner.
      const none = nSubs === 0 && !p.row;
      await writeDigest(env.DB, today, none ? 'no_subscriptions' : 'gave_up', {
        attempt: false,
        error: none ? null : p.row ? (p.row.last_error ?? 'max_attempts') : 'missed_window',
        nowIso,
      });
    } else if (p.action === 'send') {
      if (nSubs === 0) {
        res.digest = 'no_subscriptions';
        await writeDigest(env.DB, today, 'no_subscriptions', {
          attempt: false,
          error: null,
          nowIso,
        });
      } else if (!fits()) {
        res.digest = 'no_budget';
      } else {
        await recordAttempt(env.DB, today, nowIso);
        let content: PushContent | null = null;
        try {
          const d = await loadDigestInputs(env.DB, today, nowMs, tz);
          content = buildDigest(d.todayEvents, d.tomorrowEvents, d.quickNotesCount, tz, today);
        } catch {
          res.digest = 'failed';
          await writeDigest(env.DB, today, 'failed', {
            attempt: false,
            error: 'build_error',
            nowIso,
          });
        }
        if (content) {
          const { r, lastError } = await send(content, { topic: 'digest' });
          const ok = !!r && r.sent > 0;
          res.digest = ok ? 'sent' : 'failed';
          const error = ok
            ? null
            : r
              ? failCode(r.failed === 0 && r.removed > 0, lastError)
              : 'no_vapid';
          await writeDigest(env.DB, today, res.digest, { attempt: false, error, nowIso });
        }
      }
    }

    // Avisos tras el resumen: push aparte, se envian aunque el resumen haya fallado.
    if (p.reminders.length > 0 && fits()) {
      const { r } = await send(buildReminders(p.reminders, tz, today), {});
      if (r && r.sent > 0) {
        await env.DB.batch(
          p.reminders.map((i) =>
            env.DB.prepare(
              `INSERT OR IGNORE INTO reminder_log (calendar_id, event_id, start_key, status, attempts, updated_at)
               VALUES (?1, ?2, ?3, 'sent', 1, ?4)`,
            ).bind(i.calendarId, i.id, startKey(i), nowIso),
          ),
        );
        res.reminders = p.reminders.length;
      }
    }
  } finally {
    await releaseLock(env.DB, lock);
  }
  return res;
}
