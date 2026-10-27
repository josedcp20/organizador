import { now } from '../clock';
import { deleteEventDone } from '../db/eventDone';
import { deleteEventMeta } from '../db/eventMeta';
import {
  applyGoogleDelete,
  applyGoogleEvent,
  IN_FLIGHT_STALE_MS,
  isWriteInFlight,
  listQueuedWrites,
  markCalendarReadOnly,
  markChange,
  newPendingMarker,
  parsePendingPayload,
  recordPendingFailure,
  revertWrite,
  type PendingMarker,
  type WriteRow,
} from '../db/eventWrites';
import { acquireLock, releaseLock } from '../db/jobLock';
import type { Env } from '../env';
import { classify, fieldsMatch, type Failure } from '../google/agendaWrites';
import type { EventFields } from '../google/eventPayload';
import { deleteEvent, getEvent, insertEvent, patchEvent } from '../google/eventsWrite';
import { GoogleAuthError } from '../google/oauth';
import { GoogleWriteError } from '../google/writeErrors';
import { SYNC_LOCK_KEY, SYNC_LOCK_TTL_MS } from '../sync/engine';

/**
 * Cola de escrituras pendientes (T3.10): paso del cron, ANTES del sync. Reenvia a Google las
 * escrituras de la app (pending_op insert/patch/delete) que quedaron sin confirmar por un fallo
 * transitorio (red, 5xx, 429/cuota, Google desconectado) o por una peticion que murio a medias.
 *
 * - Elegibles: `write_error` NULL, 'transient' o 'not_connected' (db/eventWrites listQueuedWrites).
 *   'forbidden', 'conflict', 'rejected', 'duplicate' y 'expired' son definitivos: no se reintentan.
 * - Nunca se toca una escritura EN VUELO (isWriteInFlight: sin error y pending_since < 3 min).
 * - Backoff: la fila espera desde su ultimo intento (pending_since) 9 min * 2^(intentos-1), hasta 4 h
 *   (el cron corre cada 10 min). Tras 24 h desde el primer intento (payload.queuedAt) o
 *   PENDING_MAX_ATTEMPTS intentos se marca 'expired' sin llamar a Google.
 * - Tomar una fila: marca NUEVA (pending_since = ahora, write_error = NULL, mismo payload + queuedAt)
 *   con el compare-and-swap de markChange, conservando pending_attempts. Si la fila cambio desde que
 *   se leyo (otra escritura o el sync), se salta. Las confirmaciones van con ESA marca: nunca se
 *   limpia el pendiente de una escritura mas nueva, y se guarda el `updated` de Google (T2.10).
 * - insert: repite el POST con el MISMO id/client_id (409 duplicate propio = exito).
 * - patch: If-Match con el etag guardado. 412 -> getEvent: si Google ya tiene los campos enviados
 *   (timeout que Google aplico) es exito; si no, conflicto real: queda pendiente con
 *   write_error='conflict' (se conservan los valores del usuario; el siguiente PATCH desde la app
 *   recibe el 409 con la version de Google). 404/410: se quita la fila, la meta se conserva.
 * - delete: exito (o 404/410) borra la fila y la meta de INSTANCIA. 412 con el evento aun vivo ->
 *   se aplica la version de Google y el evento vuelve a verse. Cualquier fallo definitivo de un
 *   delete (incluido 'expired') restaura la fila visible con write_error, en vez de dejarla oculta.
 * - 403 de permiso del calendario baja su rol a 'reader' (como T3.7).
 * - Presupuesto: sin reintentos en linea; como mucho 2 peticiones por fila (+1 refresh del token),
 *   PENDING_MAX_ROWS filas por ejecucion. Un error de autenticacion corta la ejecucion.
 * - Lock: toma el mismo lock que el sync ('sync_lock'): no se solapa con otro cron ni con
 *   POST /api/sync; lo suelta antes de que corra el paso de sync.
 * Solo envia `EventFields` del payload (via toGooglePayload): nunca notas, detalles, avisos ni
 * colores. Logs: solo contadores.
 */

export const PENDING_MAX_ROWS = 5;
export const PENDING_MAX_ATTEMPTS = 10;
export const PENDING_EXPIRE_MS = 24 * 3_600_000;
const RETRY_BASE_MS = 9 * 60_000;
const RETRY_MAX_MS = 4 * 3_600_000;
/** Peticiones a Google por fila en el peor caso (escritura + lectura tras 409/412). */
export const REQUESTS_PER_ROW = 2;
/** Filas leidas por ejecucion (las no vencidas se saltan sin coste). */
const SCAN_LIMIT = 100;
const NO_INLINE_RETRY = { retries: 0 };

type RowResult = 'done' | 'retry' | 'failed' | 'expired' | 'skipped' | 'stop';

export interface PendingRunResult {
  status: 'ok' | 'busy';
  /** Peticiones a Google reservadas (peor caso) por esta ejecucion. */
  requests: number;
  counts: Record<Exclude<RowResult, 'stop'>, number>;
}

/** Espera minima desde el ultimo intento antes de reintentar. */
export function retryDelayMs(attempts: number): number {
  if (attempts <= 0) return IN_FLIGHT_STALE_MS;
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
}

const markerOf = (r: WriteRow): PendingMarker => ({
  op: r.pending_op!,
  since: r.pending_since ?? '',
  payload: r.pending_payload ?? '',
});

const queuedAtOf = (r: WriteRow) =>
  parsePendingPayload(r.pending_payload)?.queuedAt ?? r.pending_since;

function isDue(r: WriteRow, nowMs: number): boolean {
  return (
    !r.pending_since || Date.parse(r.pending_since) <= nowMs - retryDelayMs(r.pending_attempts)
  );
}

function isExpired(r: WriteRow, nowMs: number): boolean {
  const q = queuedAtOf(r);
  return (
    r.pending_attempts >= PENDING_MAX_ATTEMPTS ||
    (q !== null && Date.parse(q) <= nowMs - PENDING_EXPIRE_MS)
  );
}

const deleteInstanceMeta = async (env: Env, r: WriteRow) => {
  await deleteEventMeta(env.DB, { calendarId: r.calendar_id, scope: 'instance', targetId: r.id });
  await deleteEventDone(env.DB, r.calendar_id, r.id);
};

/**
 * Fallo definitivo: insert/patch quedan pendientes con el motivo (la UI lo muestra y no se
 * reintenta); un delete se deshace (fila visible otra vez) guardando el motivo.
 */
async function giveUp(env: Env, r: WriteRow, m: PendingMarker, code: string): Promise<void> {
  if (r.pending_op !== 'delete') {
    await recordPendingFailure(env.DB, r.calendar_id, r.id, m, code);
    return;
  }
  const visible: WriteRow = {
    ...r,
    pending_op: null,
    pending_payload: null,
    pending_scope: null,
    pending_attempts: 0,
    pending_since: null,
    write_error: null,
  };
  await revertWrite(env.DB, visible, r.calendar_id, r.id, m, { writeError: code });
}

const retryLater = async (env: Env, r: WriteRow, m: PendingMarker, reason: string) => {
  await recordPendingFailure(env.DB, r.calendar_id, r.id, m, reason);
  return 'retry' as const;
};

/** Reintenta UNA fila pendiente. Exportada para tests (CAS con una fila ya cambiada). */
export async function retryPendingRow(env: Env, r: WriteRow): Promise<RowResult> {
  const op = r.pending_op;
  if (!op) return 'skipped';
  const payload = parsePendingPayload(r.pending_payload);
  const fields = payload?.fields as EventFields | undefined;
  const queuedAt = queuedAtOf(r) ?? new Date(now()).toISOString();
  const m = newPendingMarker(op, fields, queuedAt);
  if (!(await markChange(env.DB, r, {}, m, r.pending_attempts))) return 'skipped';

  const opts = { retry: NO_INLINE_RETRY, pending: m };
  const calendarId = r.calendar_id;
  const eventId = r.id;
  try {
    if (op === 'insert') {
      if (!r.local_id || !fields) throw new GoogleWriteError('invalid_payload');
      await insertEvent(env, { calendarId, localId: r.local_id, fields, eventId }, opts);
    } else if (op === 'patch') {
      if (!fields) throw new GoogleWriteError('invalid_payload');
      await patchEvent(env, { calendarId, eventId, etag: r.etag ?? '', fields }, opts);
    } else {
      await deleteEvent(env, { calendarId, eventId, etag: r.etag ?? '' }, opts);
      await deleteInstanceMeta(env, r);
    }
    return 'done';
  } catch (e) {
    return await onFailure(env, r, m, fields, e);
  }
}

async function onFailure(
  env: Env,
  r: WriteRow,
  m: PendingMarker,
  fields: EventFields | undefined,
  e: unknown,
): Promise<RowResult> {
  if (e instanceof GoogleAuthError) {
    await recordPendingFailure(
      env.DB,
      r.calendar_id,
      r.id,
      m,
      e.code === 'unavailable' ? 'transient' : 'not_connected',
    );
    return 'stop';
  }
  let f: Failure;
  try {
    f = classify(e);
  } catch {
    // No es un error de Google (bug, D1...): se reintentara, acotado por la expiracion.
    console.error('pending_writes', 'unexpected', e instanceof Error ? e.name : 'unknown');
    return retryLater(env, r, m, 'transient');
  }
  const op = r.pending_op;
  if (f === 'transient') return retryLater(env, r, m, 'transient');
  if (f === 'conflict' && op !== 'insert') return resolveConflict(env, r, m, fields);
  if ((f === 'missing' || f === 'gone') && op === 'patch') {
    // El evento ya no existe (o no es visible) en Google: fuera de D1; la meta se conserva (T3.7).
    await applyGoogleDelete(env.DB, r.calendar_id, r.id, { pending: m });
    return 'done';
  }
  if (f === 'forbidden' || (f === 'missing' && op === 'insert')) {
    await markCalendarReadOnly(env.DB, r.calendar_id);
    await giveUp(env, r, m, 'forbidden');
  } else if (f === 'denied') {
    await giveUp(env, r, m, 'forbidden');
  } else if (f === 'duplicate' || f === 'conflict') {
    await giveUp(env, r, m, 'duplicate');
  } else {
    await giveUp(env, r, m, 'rejected');
  }
  return 'failed';
}

/** 412: falso conflicto (Google ya aplico lo enviado) = exito; real = 'conflict' sin reintento. */
async function resolveConflict(
  env: Env,
  r: WriteRow,
  m: PendingMarker,
  fields: EventFields | undefined,
): Promise<RowResult> {
  let current;
  try {
    current = await getEvent(env, r.calendar_id, r.id, { retry: NO_INLINE_RETRY });
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      await recordPendingFailure(env.DB, r.calendar_id, r.id, m, 'not_connected');
      return 'stop';
    }
    return retryLater(env, r, m, 'transient');
  }
  if (!current) {
    await applyGoogleDelete(env.DB, r.calendar_id, r.id, { pending: m });
    if (r.pending_op === 'delete') await deleteInstanceMeta(env, r);
    return 'done';
  }
  if (r.pending_op === 'delete') {
    // Cambiado en Google desde que se pidio borrar: no se borra; vuelve a verse su version actual.
    await applyGoogleEvent(env.DB, r.calendar_id, current, { pending: m });
    return 'failed';
  }
  if (fields && fieldsMatch(fields, current)) {
    await applyGoogleEvent(env.DB, r.calendar_id, current, { pending: m });
    return 'done';
  }
  await recordPendingFailure(env.DB, r.calendar_id, r.id, m, 'conflict');
  return 'failed';
}

/**
 * Ejecuta la cola. `budget`: peticiones a Google disponibles para este paso (el despachador
 * descuenta `requests` del presupuesto del sync).
 */
export async function runPendingWrites(
  env: Env,
  opts: { nowMs?: number; budget?: number } = {},
): Promise<PendingRunResult> {
  const nowMs = opts.nowMs ?? now();
  const maxRows = Math.max(
    0,
    Math.min(PENDING_MAX_ROWS, Math.floor(((opts.budget ?? Infinity) - 1) / REQUESTS_PER_ROW)),
  );
  const res: PendingRunResult = {
    status: 'ok',
    requests: 0,
    counts: { done: 0, retry: 0, failed: 0, expired: 0, skipped: 0 },
  };
  if (maxRows === 0) return res;
  const lock = await acquireLock(env.DB, SYNC_LOCK_KEY, SYNC_LOCK_TTL_MS, nowMs);
  if (!lock) return { ...res, status: 'busy' };
  let taken = 0;
  try {
    for (const r of await listQueuedWrites(env.DB, SCAN_LIMIT)) {
      if (taken >= maxRows) break;
      if (isWriteInFlight(r, nowMs)) continue;
      if (isExpired(r, nowMs)) {
        await giveUp(env, r, markerOf(r), 'expired');
        res.counts.expired++;
        continue;
      }
      if (!isDue(r, nowMs)) continue;
      taken++;
      const out = await retryPendingRow(env, r);
      if (out === 'stop') {
        res.counts.retry++;
        break;
      }
      res.counts[out]++;
    }
  } finally {
    res.requests = taken > 0 ? 1 + taken * REQUESTS_PER_ROW : 0;
    await releaseLock(env.DB, lock);
  }
  return res;
}
