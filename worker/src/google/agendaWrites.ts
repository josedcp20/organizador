import type { AgendaWriteErrorCode, EventInfo } from '@organizador/shared';
import { now } from '../clock';
import { isWritableRole } from '../db/calendars';
import { deleteEventDone } from '../db/eventDone';
import { deleteEventMeta } from '../db/eventMeta';
import { getEventById } from '../db/eventsRead';
import {
  applyGoogleDelete,
  applyGoogleEvent,
  calendarAccessRole,
  isWriteInFlight,
  loadWriteRow,
  markCalendarReadOnly,
  markChange,
  markInsert,
  newPendingMarker,
  parsePendingPayload,
  recordPendingFailure,
  revertWrite,
  rowByLocalId,
  type PendingMarker,
  type WriteRow,
} from '../db/eventWrites';
import type { Env } from '../env';
import type { CreateInput, PatchInput } from '../routes/agendaInput';
import type { ParsedEvent } from '../sync/parse';
import { DEFAULT_TZ, syncWindow } from '../sync/window';
import { eventIdFor, type EventFields } from './eventPayload';
import { deleteEvent, getEvent, insertEvent, patchEvent } from './eventsWrite';
import { GoogleAuthError } from './oauth';
import { GoogleWriteError, isCalendarPermissionReason, type RetryOptions } from './writeErrors';

/**
 * Escrituras de eventos pedidas por la app (T3.7): validacion de permisos/estado en D1,
 * actualizacion OPTIMISTA de D1 con una marca pendiente propia, llamada a Google (eventsWrite.ts,
 * que construye el cuerpo SOLO con toGooglePayload) y resolucion:
 * - exito: se aplica la respuesta de Google y se limpia el pendiente SOLO si sigue siendo el de
 *   esta escritura (nunca se borra un pendiente posterior).
 * - Google rechaza sin aplicar (403, 400, desconectado...): se revierte D1 a como estaba. Un 403
 *   de permiso ademas guarda `write_error='forbidden'` (patch/delete) y baja el rol del calendario
 *   a 'reader' en D1 (deja de ofrecerse como escribible hasta el siguiente import de calendarList).
 * - transitorio (5xx/red/cuota) o resultado incierto: la fila queda con pending_op y
 *   pending_payload para la cola de reintentos (T3.10); la ruta responde 202.
 * - Concurrencia: con otra escritura del mismo evento EN VUELO (ver isWriteInFlight) se responde
 *   409 `write_pending` sin tocar la fila; solo se fusiona/reescribe un pendiente que ya fallo.
 * Nunca envia meta privada (notas, avisos, colores): solo `EventFields` validados.
 */

/** Opciones de ejecucion (los tests anulan las esperas de los reintentos en linea). */
export const writeRuntime: { retry?: RetryOptions } = {};

export type WriteOutcome =
  | { kind: 'ok'; status: 200 | 201; event: EventInfo | null }
  | { kind: 'deleted' }
  | { kind: 'pending'; event: EventInfo | null }
  | {
      kind: 'error';
      status: 400 | 403 | 404 | 409 | 410 | 423 | 428 | 500 | 501 | 502;
      code: AgendaWriteErrorCode;
      message: string;
      /** Solo en `conflict`: version actual de Google (ya aplicada en D1). */
      current?: EventInfo | null;
    };

const err = (
  status: Extract<WriteOutcome, { kind: 'error' }>['status'],
  code: AgendaWriteErrorCode,
  message: string,
): WriteOutcome => ({ kind: 'error', status, code, message });

const FORBIDDEN = () => err(403, 'calendar_forbidden', 'No write permission on this calendar');
const FROZEN = () => err(423, 'frozen', 'Event is before the sync window and cannot be changed');
const PENDING = () =>
  err(409, 'write_pending', 'Another write to this event is pending; retry or discard it first');

const tzOf = (env: Env) => env.TZ || DEFAULT_TZ;

/** Regla de congelado (D6), la misma que eventsRead/sync: inicio anterior a la ventana. */
function isFrozenKey(allDay: boolean, key: string | null, env: Env): boolean {
  const w = syncWindow(now(), tzOf(env));
  return allDay ? (key ?? '') < w.startDate : (key ?? '') < w.timeMin;
}

const rowFrozen = (r: WriteRow, env: Env) =>
  isFrozenKey(r.all_day === 1, r.all_day === 1 ? r.start_date : r.start_at, env);

const readInfo = (env: Env, calendarId: string, eventId: string) =>
  getEventById(env.DB, calendarId, eventId, { tz: tzOf(env), forWrite: true });

export type Failure =
  | 'transient'
  | 'forbidden' // 403 de permiso del calendario: baja el rol en D1
  | 'denied' // 403 del evento / desconocido / local: se revierte sin tocar el rol
  | 'not_connected'
  | 'misconfigured'
  | 'conflict'
  | 'missing'
  | 'duplicate'
  | 'gone'
  | 'rejected';

/** Clasifica el error de una llamada a Google; lo que no es de Google se relanza (500). */
export function classify(e: unknown): Failure {
  if (e instanceof GoogleAuthError) {
    if (e.code === 'unavailable') return 'transient';
    if (e.code === 'misconfigured') return 'misconfigured';
    return 'not_connected';
  }
  if (!(e instanceof GoogleWriteError)) throw e;
  switch (e.kind) {
    case 'transient':
    case 'rate_limited':
    case 'bad_response': // Google respondio 2xx pero algo raro: no se sabe si se aplico
      return 'transient';
    case 'forbidden':
      return isCalendarPermissionReason(e.reason) ? 'forbidden' : 'denied';
    case 'read_only':
    case 'calendar_not_found':
      return 'denied';
    case 'conflict':
      return 'conflict';
    case 'not_found':
      return 'missing';
    case 'gone':
      return 'gone';
    case 'duplicate':
      return 'duplicate';
    default:
      return 'rejected';
  }
}

/** Errores que se resuelven igual en las tres operaciones: revertir y responder. */
function revertedOutcome(f: Failure): WriteOutcome | null {
  if (f === 'forbidden' || f === 'denied') return FORBIDDEN();
  if (f === 'not_connected') return err(409, 'google_not_connected', 'Google is not connected');
  if (f === 'misconfigured') return err(500, 'misconfigured', 'Google OAuth is not configured');
  if (f === 'rejected') return err(400, 'google_rejected', 'Google rejected the event data');
  return null;
}

async function keepPending(
  env: Env,
  calendarId: string,
  eventId: string,
  m: PendingMarker,
  reason: string,
): Promise<WriteOutcome> {
  await recordPendingFailure(env.DB, calendarId, eventId, m, reason);
  return { kind: 'pending', event: await readInfo(env, calendarId, eventId) };
}

const opts = (m: PendingMarker) => ({ retry: writeRuntime.retry, pending: m });

// ---------------------------------------------------------------------------------------------

export async function createAgendaEvent(env: Env, input: CreateInput): Promise<WriteOutcome> {
  const { calendarId, localId } = input;
  const role = await calendarAccessRole(env.DB, calendarId);
  if (role === undefined || !isWritableRole(role)) return FORBIDDEN();
  if (isFrozenKey(input.allDay, input.startKey, env)) return FROZEN();

  const eventId = await eventIdFor(localId);
  const other = await rowByLocalId(env.DB, localId);
  if (other && (other.calendar_id !== calendarId || other.id !== eventId)) {
    return err(409, 'duplicate', 'client_id already used for another event');
  }
  const existing = await loadWriteRow(env.DB, calendarId, eventId);
  if (existing) {
    if (existing.local_id !== localId) {
      return err(409, 'duplicate', 'client_id already used for another event');
    }
    // Ya confirmado (o con un patch posterior): POST repetido idempotente, sin llamar a Google.
    if (existing.pending_op === null || existing.pending_op === 'patch') {
      return { kind: 'ok', status: 200, event: await readInfo(env, calendarId, eventId) };
    }
    if (existing.pending_op === 'delete') return PENDING();
    // pending 'insert' de un POST anterior que fallo: reintento del mismo alta (Google 409
    // duplicate = exito). Si ese POST sigue en vuelo, no se le pisa la marca (markInsert tambien
    // lo comprueba de forma atomica).
    if (isWriteInFlight(existing)) return PENDING();
  }

  const m = newPendingMarker('insert', input.fields);
  let marked: boolean;
  try {
    marked = await markInsert(env.DB, calendarId, eventId, localId, input.display, m);
  } catch (e) {
    // Indice unico de local_id: otro POST simultaneo con el mismo client_id en otro calendario.
    if (/UNIQUE|constraint/i.test(String((e as Error)?.message))) {
      return err(409, 'duplicate', 'client_id already used for another event');
    }
    throw e;
  }
  if (!marked) return PENDING();
  try {
    await insertEvent(env, { calendarId, localId, fields: input.fields, eventId }, opts(m));
  } catch (e) {
    const f = classify(e);
    if (f === 'transient') return keepPending(env, calendarId, eventId, m, 'transient');
    // Rechazado sin aplicar: fuera la fila optimista (un alta nunca tiene estado previo util).
    await revertWrite(env.DB, null, calendarId, eventId, m);
    if (f === 'gone') return err(410, 'gone', 'This event was already deleted in Google');
    // 403, o 404 en un insert (Google no deja ver el calendario): sin acceso de escritura.
    if (f === 'forbidden' || f === 'missing') {
      await markCalendarReadOnly(env.DB, calendarId);
      return FORBIDDEN();
    }
    if (f === 'denied') {
      return FORBIDDEN();
    }
    if (f === 'duplicate' || f === 'conflict') {
      return err(409, 'duplicate', 'An event with this id already exists in Google');
    }
    return revertedOutcome(f)!;
  }
  return { kind: 'ok', status: 201, event: await readInfo(env, calendarId, eventId) };
}

/** Comprobaciones comunes de PATCH/DELETE antes de tocar nada (sin llamar a Google). */
async function checkExisting(
  env: Env,
  calendarId: string,
  eventId: string,
  confirmExternal: boolean,
): Promise<{ row: WriteRow } | { outcome: WriteOutcome }> {
  const row = await loadWriteRow(env.DB, calendarId, eventId);
  const role = row ? await calendarAccessRole(env.DB, calendarId) : undefined;
  if (!row || row.status === 'cancelled' || role === undefined) {
    return { outcome: err(404, 'not_found', 'Event not found') };
  }
  if (row.recurring_event_id) {
    return {
      outcome: err(501, 'recurring_not_supported', 'Recurring events must be edited in Google'),
    };
  }
  if (!isWritableRole(role)) return { outcome: FORBIDDEN() };
  if (rowFrozen(row, env)) return { outcome: FROZEN() };
  if (row.origin !== 'app' && !confirmExternal) {
    return {
      outcome: err(
        428,
        'confirmation_required',
        'This event was not created in the app: confirm_external is required',
      ),
    };
  }
  // Un alta sin confirmar no tiene etag (no hay base para If-Match): primero debe resolverse.
  if (row.pending_op === 'insert' || !row.etag) return { outcome: PENDING() };
  // Otra escritura en vuelo: su confirmacion dejaria este If-Match gastado (412 -> conflicto falso)
  // y su marca podria resucitar al revertir esta. markChange (compare-and-swap) cubre la carrera.
  if (isWriteInFlight(row)) return { outcome: PENDING() };
  return { row };
}

/** Los campos enviados ya coinciden con la version de Google (falso conflicto tras un timeout). */
export function fieldsMatch(f: EventFields, ev: ParsedEvent): boolean {
  const txt = (v: string | null | undefined) => v ?? '';
  for (const k of ['summary', 'location', 'description'] as const) {
    if (f[k] !== undefined && txt(f[k]) !== txt(ev[k])) return false;
  }
  if (f.start && f.end) {
    if (f.start.allDay && f.end.allDay) {
      if (!ev.allDay || ev.startDate !== f.start.date || ev.endDate !== f.end.date) return false;
    } else if (!f.start.allDay && !f.end.allDay) {
      const iso = (s: string) => new Date(Date.parse(s)).toISOString();
      if (ev.allDay || ev.startAt !== iso(f.start.dateTime) || ev.endAt !== iso(f.end.dateTime)) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

export async function patchAgendaEvent(
  env: Env,
  calendarId: string,
  eventId: string,
  input: PatchInput,
): Promise<WriteOutcome> {
  const checked = await checkExisting(env, calendarId, eventId, input.confirmExternal);
  if ('outcome' in checked) return checked.outcome;
  const row = checked.row;
  if (input.time) {
    if (input.time.allDay !== (row.all_day === 1)) {
      return err(400, 'validation', 'Changing between all-day and timed is not supported');
    }
    if (isFrozenKey(input.time.allDay, input.time.startKey, env)) return FROZEN();
  }
  if (row.pending_op === 'delete') return PENDING();

  // Un patch anterior que ya FALLO (no en vuelo: checkExisting) se FUSIONA: este envia sus campos +
  // los nuevos y su marca sustituye a la anterior.
  let fields: EventFields = input.fields;
  if (row.pending_op === 'patch') {
    const prev = parsePendingPayload(row.pending_payload)?.fields as EventFields | undefined;
    if (prev && typeof prev === 'object') fields = { ...prev, ...input.fields };
  }
  const m = newPendingMarker('patch', fields);
  if (!(await markChange(env.DB, row, input.display, m))) return PENDING();

  try {
    await patchEvent(env, { calendarId, eventId, etag: row.etag!, fields }, opts(m));
  } catch (e) {
    const f = classify(e);
    if (f === 'transient') return keepPending(env, calendarId, eventId, m, 'transient');
    if (f === 'conflict') return resolveConflict(env, calendarId, eventId, row, m, fields);
    if (f === 'missing' || f === 'gone') return goneOnPatch(env, calendarId, eventId, m);
    return revertFailed(env, row, calendarId, eventId, m, f);
  }
  return { kind: 'ok', status: 200, event: await readInfo(env, calendarId, eventId) };
}

/**
 * PATCH con 404/410 de Google. Criterio: 410 = borrado seguro; 404 = el evento ya no es visible
 * para esta cuenta (borrado, o perdida de acceso al calendario: Google no distingue). En ambos
 * casos se quita la fila de `events` (es solo cache: si sigue existiendo y visible, el siguiente
 * sync la recupera; si se perdio el calendario, el import de calendarList lo marca desaparecido),
 * con guarda de marca (no se borra la fila si otra escritura ya la tomo). La meta privada de
 * instancia NO se borra: el usuario no borro el evento desde la app y una perdida de acceso
 * temporal no debe destruir notas irrecuperables (plan, seccion 3: "si Google borra el evento la
 * nota se conserva, huerfana visible en Ajustes").
 */
async function goneOnPatch(
  env: Env,
  calendarId: string,
  eventId: string,
  m: PendingMarker,
): Promise<WriteOutcome> {
  await applyGoogleDelete(env.DB, calendarId, eventId, { pending: m });
  return err(404, 'not_found', 'Event no longer exists in Google');
}

/** Google rechazo la escritura sin aplicarla: se revierte D1; un 403 ademas baja el rol. */
async function revertFailed(
  env: Env,
  before: WriteRow,
  calendarId: string,
  eventId: string,
  m: PendingMarker,
  f: Failure,
): Promise<WriteOutcome> {
  const forbidden = f === 'forbidden';
  await revertWrite(
    env.DB,
    before,
    calendarId,
    eventId,
    m,
    forbidden ? { writeError: 'forbidden' } : {},
  );
  if (forbidden) await markCalendarReadOnly(env.DB, calendarId);
  return revertedOutcome(f) ?? err(502, 'google_error', 'Google request failed');
}

/**
 * 412: se lee la version actual. Si ya tiene lo que se envio (el intento anterior SI se aplico y
 * expiro la respuesta) es un exito; si no, se guarda en D1 y se devuelve como conflicto.
 */
async function resolveConflict(
  env: Env,
  calendarId: string,
  eventId: string,
  before: WriteRow,
  m: PendingMarker,
  sent: EventFields | null,
): Promise<WriteOutcome> {
  let current: ParsedEvent | null;
  try {
    current = await getEvent(env, calendarId, eventId, { retry: writeRuntime.retry });
  } catch (e) {
    const f = classify(e);
    // 'transient' (no 'conflict'): la cola de T3.10 lo reintenta; el 412 se resolvera entonces.
    if (f === 'transient') return keepPending(env, calendarId, eventId, m, 'transient');
    return revertFailed(env, before, calendarId, eventId, m, f);
  }
  if (!current) {
    await applyGoogleDelete(env.DB, calendarId, eventId, { pending: m });
    if (!sent) {
      await deleteInstanceMeta(env, calendarId, eventId);
      return { kind: 'deleted' };
    }
    return err(404, 'not_found', 'Event no longer exists in Google');
  }
  await applyGoogleEvent(env.DB, calendarId, current, { pending: m });
  if (sent && fieldsMatch(sent, current)) {
    return { kind: 'ok', status: 200, event: await readInfo(env, calendarId, eventId) };
  }
  return {
    kind: 'error',
    status: 409,
    code: 'conflict',
    message: 'The event changed in Google',
    current: await readInfo(env, calendarId, eventId),
  };
}

const deleteInstanceMeta = async (env: Env, calendarId: string, eventId: string) => {
  await deleteEventMeta(env.DB, { calendarId, scope: 'instance', targetId: eventId });
  await deleteEventDone(env.DB, calendarId, eventId);
};

export async function deleteAgendaEvent(
  env: Env,
  calendarId: string,
  eventId: string,
  confirmExternal: boolean,
): Promise<WriteOutcome> {
  const checked = await checkExisting(env, calendarId, eventId, confirmExternal);
  if ('outcome' in checked) return checked.outcome;
  const row = checked.row;
  const m = newPendingMarker('delete');
  if (!(await markChange(env.DB, row, {}, m))) return PENDING();
  try {
    // 204, o 404/410 (ya no estaba) = exito; borra la fila de events.
    await deleteEvent(env, { calendarId, eventId, etag: row.etag! }, opts(m));
  } catch (e) {
    const f = classify(e);
    if (f === 'transient') return keepPending(env, calendarId, eventId, m, 'transient');
    if (f === 'conflict') return resolveConflict(env, calendarId, eventId, row, m, null);
    return revertFailed(env, row, calendarId, eventId, m, f);
  }
  // Borrado desde la app: fuera la meta de la INSTANCIA (la de serie no se toca).
  await deleteInstanceMeta(env, calendarId, eventId);
  return { kind: 'deleted' };
}
