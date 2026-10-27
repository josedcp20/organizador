import { ALARM_PUSH_TEXT, NOTE_ALARM_LIMITS, PUSH_LIMITS } from '@organizador/shared';
import { acquireLock, releaseLock } from '../db/jobLock';
import type { Env } from '../env';
import { sendToAll } from '../push/send';

/**
 * Alarmas de notas rapidas (H5): paso del cron `*\/10` (sin cron propio, enmienda del usuario).
 * - Vencidas: `remind_state='pending' AND remind_at <= ahora` (rango: una ejecucion perdida la
 *   recoge la siguiente) y nota viva; en orden de `remind_at`, como mucho `maxRows` por ejecucion.
 * - Sin vencidas: solo una lectura, 0 escrituras (ni siquiera el lock).
 * - Lock propio `alarm_lock` y RELECTURA dentro del lock: una ejecucion solapada no reenvia lo que
 *   otra acaba de marcar `sent`.
 * - Retraso > retryWindowMs o attempts >= maxAttempts -> `gave_up` sin enviar.
 *   Envio: >= 1 entrega -> `sent` (despues de enviar: nunca perder > nunca duplicar; el tag
 *   `alarm-<id>` sustituye un duplicado en iOS); algun fallo -> attempts+1 y sigue pending;
 *   sin VAPID o sin suscripciones vivas -> `gave_up`.
 * - Todo UPDATE es CAS sobre (pending, remind_at leido): una edicion concurrente no se pisa.
 * Payload fijo `ALARM_PUSH_TEXT` (nunca el texto de la nota). Logs: solo contadores.
 */

export const ALARM_LOCK_KEY = 'alarm_lock';
export const ALARM_LOCK_TTL_MS = 5 * 60_000;
/** TTL del push = ventana de reintentos (pasada esa hora ya no tiene sentido que suene). */
export const ALARM_TTL_S = NOTE_ALARM_LIMITS.retryWindowMs / 1000;

type Outcome = 'sent' | 'retry' | 'gave_up' | 'skipped';

export interface AlarmRunResult {
  status: 'idle' | 'busy' | 'ok';
  /** Peticiones push hechas (cota superior), para descontar del presupuesto del sync. */
  requests: number;
  counts: Record<Outcome, number>;
}

interface DueRow {
  id: string;
  remind_at: string;
  remind_attempts: number;
}

async function listDue(db: D1Database, nowIso: string, limit: number): Promise<DueRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, remind_at, remind_attempts FROM notes
       WHERE remind_state = 'pending' AND remind_at <= ?1 AND (expires_at IS NULL OR expires_at > ?1)
       ORDER BY remind_at LIMIT ?2`,
    )
    .bind(nowIso, limit)
    .all<DueRow>();
  return results;
}

/** CAS: solo si la alarma sigue siendo la que se leyo. */
async function finish(db: D1Database, r: DueRow, state: 'sent' | 'gave_up' | 'retry') {
  const set =
    state === 'retry' ? 'remind_attempts = remind_attempts + 1' : `remind_state = '${state}'`;
  const res = await db
    .prepare(
      `UPDATE notes SET ${set} WHERE id = ?1 AND remind_state = 'pending' AND remind_at = ?2`,
    )
    .bind(r.id, r.remind_at)
    .run();
  return res.meta.changes === 1;
}

async function processRow(env: Env, r: DueRow, nowMs: number, res: AlarmRunResult) {
  const late = nowMs - Date.parse(r.remind_at) > NOTE_ALARM_LIMITS.retryWindowMs;
  if (late || r.remind_attempts >= NOTE_ALARM_LIMITS.maxAttempts) {
    console.log('alarm', 'gave_up', late ? 'missed' : 'attempts');
    return (await finish(env.DB, r, 'gave_up')) ? 'gave_up' : 'skipped';
  }
  const sent = await sendToAll(
    env,
    {
      v: 1,
      title: ALARM_PUSH_TEXT,
      body: ALARM_PUSH_TEXT,
      url: `#/notas?nota=${encodeURIComponent(r.id)}`,
      tag: `alarm-${r.id}`,
    },
    { ttl: ALARM_TTL_S, urgency: 'high' },
  );
  if (sent) res.requests += sent.sent + sent.failed + sent.removed;
  const state = !sent ? 'gave_up' : sent.sent > 0 ? 'sent' : sent.failed > 0 ? 'retry' : 'gave_up';
  if (state === 'gave_up') console.log('alarm', 'gave_up', sent ? 'no_subscriptions' : 'no_vapid');
  return (await finish(env.DB, r, state)) ? state : 'skipped';
}

/**
 * Ejecuta las alarmas vencidas. `budget`: subrequests disponibles para este paso; cada alarma
 * reserva el peor caso (una peticion por suscripcion).
 */
export async function runAlarms(
  env: Env,
  nowMs: number,
  budget = Infinity,
): Promise<AlarmRunResult> {
  const res: AlarmRunResult = {
    status: 'idle',
    requests: 0,
    counts: { sent: 0, retry: 0, gave_up: 0, skipped: 0 },
  };
  const maxRows = Math.min(
    NOTE_ALARM_LIMITS.perRun,
    Math.floor(budget / PUSH_LIMITS.maxSubscriptions),
  );
  const nowIso = new Date(nowMs).toISOString();
  if (maxRows <= 0 || (await listDue(env.DB, nowIso, 1)).length === 0) return res;
  const lock = await acquireLock(env.DB, ALARM_LOCK_KEY, ALARM_LOCK_TTL_MS, nowMs);
  if (!lock) return { ...res, status: 'busy' };
  res.status = 'ok';
  try {
    for (const r of await listDue(env.DB, nowIso, maxRows)) {
      res.counts[await processRow(env, r, nowMs, res)]++;
    }
  } finally {
    await releaseLock(env.DB, lock);
  }
  return res;
}
