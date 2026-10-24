import { isWritableRole } from '../db/calendars';
import {
  applyGoogleDelete,
  applyGoogleEvent,
  calendarAccessRole,
  type PendingMarker,
} from '../db/eventWrites';
import type { Env } from '../env';
import { parseGoogleEvent, type ParsedEvent } from '../sync/parse';
import { DEFAULT_TZ } from '../sync/window';
import {
  deleteEventRequest,
  getEventRequest,
  GoogleApiError,
  insertEventRequest,
  isValidEtag,
  patchEventRequest,
} from './calendarApi';
import { eventIdFor, PayloadError, toGooglePayload, type EventFields } from './eventPayload';
import { GoogleAuthError, forgetAccessToken, getAccessToken } from './oauth';
import {
  GoogleWriteError,
  isAuthRejection,
  toWriteError,
  withRetries,
  type RetryOptions,
} from './writeErrors';

/**
 * Escrituras de eventos en Google Calendar (T2.10, D10): insert / patch / delete de UN evento.
 * Capa Google + aplicacion de la respuesta a D1; sin rutas HTTP (T3.7 las anade encima).
 *
 * - Solo en calendarios con rol owner/writer en D1. reader/freeBusyReader -> GoogleWriteError
 *   `read_only` SIN llamar a Google (ni pedir token).
 * - El cuerpo SIEMPRE sale de `toGooglePayload` (lista blanca de campos de evento). Este modulo
 *   recibe `EventFields`, nunca meta privada (notas, avisar, color...).
 * - insert: id propio base32hex determinista a partir del organizadorId; 409 duplicate =
 *   idempotente (ya existe): se lee el evento (events.get) y se comprueba que es nuestro.
 * - patch: If-Match con el etag del BODY; 412 -> GoogleWriteError `conflict`.
 * - delete: If-Match; 410 (ya borrado) o 404 = exito.
 * - 401 / 403 insufficientPermissions -> se olvida el access token y GoogleAuthError
 *   `not_connected` (las rutas responden 409 google_not_connected, como en lectura).
 * - Resto de errores -> GoogleWriteError tipado (ver writeErrors.ts); los transitorios (5xx/red)
 *   se reintentan en linea como mucho 2 veces con backoff y jitter.
 * - Exito: la version devuelta por Google (etag y `updated` del body) se guarda en `events` y se
 *   limpia `pending_op` (contrato con la purga del sync completo, ver db/eventWrites.ts).
 * Logs: solo codigos y status, nunca ids de calendario/evento ni contenido.
 */

export interface WriteOptions {
  retry?: RetryOptions;
  /**
   * Marca pendiente de la escritura (T3.7): al confirmar solo se limpia el pendiente si la fila
   * sigue teniendo ESTA marca (ver db/eventWrites.ts).
   */
  pending?: PendingMarker;
}

export interface InsertInput {
  calendarId: string;
  /** organizadorId de la app (uuid): va a extendedProperties.private y a events.local_id. */
  localId: string;
  fields: EventFields;
  /** Id de Google; por defecto `eventIdFor(localId)` (determinista, idempotente). */
  eventId?: string;
}

export interface InsertResult {
  /** false si Google respondio 409 duplicate (el evento ya existia: reintento idempotente). */
  created: boolean;
  event: ParsedEvent;
}

export interface PatchInput {
  calendarId: string;
  eventId: string;
  /** etag del BODY del evento (columna events.etag). */
  etag: string;
  fields: EventFields;
}

export interface DeleteInput {
  calendarId: string;
  eventId: string;
  etag: string;
}

export interface DeleteResult {
  /** true si Google ya no lo tenia (410 deleted / 404). */
  alreadyDeleted: boolean;
}

const MAX_EVENT_ID = 1024;

function checkEventId(eventId: unknown): asserts eventId is string {
  if (typeof eventId !== 'string' || !eventId || eventId.length > MAX_EVENT_ID) {
    throw new GoogleWriteError('invalid_payload');
  }
}

function checkEtag(etag: unknown): asserts etag is string {
  if (!isValidEtag(etag)) throw new GoogleWriteError('invalid_payload');
}

/** Solo owner/writer en D1. No llama a Google. */
async function ensureWritable(env: Env, calendarId: string): Promise<void> {
  if (typeof calendarId !== 'string' || !calendarId) {
    throw new GoogleWriteError('calendar_not_found');
  }
  const role = await calendarAccessRole(env.DB, calendarId);
  if (role === undefined) throw new GoogleWriteError('calendar_not_found');
  if (!isWritableRole(role)) throw new GoogleWriteError('read_only');
}

function buildPayload(...args: Parameters<typeof toGooglePayload>) {
  try {
    return toGooglePayload(...args);
  } catch (e) {
    if (e instanceof PayloadError) throw new GoogleWriteError('invalid_payload');
    throw e;
  }
}

/** Ejecuta una llamada a Google con reintentos y traduce los errores. */
async function callGoogle<T>(env: Env, op: string, fn: () => Promise<T>, opts: WriteOptions) {
  try {
    return await withRetries(fn, opts.retry);
  } catch (e) {
    if (isAuthRejection(e)) {
      await forgetAccessToken(env.DB);
      console.warn('google_write', op, 'auth_rejected');
      throw new GoogleAuthError('not_connected');
    }
    const err = toWriteError(e);
    console.warn('google_write', op, err.kind, err.status ?? '', err.reason ?? '');
    throw err;
  }
}

function parseResponse(body: unknown, op: string): ParsedEvent {
  const item = parseGoogleEvent(body);
  if (item.kind !== 'event') {
    console.warn('google_write', op, 'bad_response', item.kind);
    throw new GoogleWriteError(item.kind === 'cancelled' ? 'gone' : 'bad_response');
  }
  return item.event;
}

const tzOf = (env: Env) => env.TZ || DEFAULT_TZ;

/** Crea un evento (no recurrente) en Google y lo guarda en D1 con origin='app'. */
export async function insertEvent(
  env: Env,
  input: InsertInput,
  opts: WriteOptions = {},
): Promise<InsertResult> {
  await ensureWritable(env, input.calendarId);
  let eventId: string;
  try {
    eventId = input.eventId ?? (await eventIdFor(input.localId));
  } catch {
    throw new GoogleWriteError('invalid_payload');
  }
  const payload = buildPayload(input.fields, 'insert', {
    id: eventId,
    organizadorId: input.localId,
    timeZone: tzOf(env),
  });
  const token = await getAccessToken(env);

  let created = true;
  let body: unknown;
  try {
    body = await callGoogle(
      env,
      'insert',
      () => insertEventRequest(token, input.calendarId, payload),
      opts,
    );
  } catch (e) {
    if (!(e instanceof GoogleWriteError) || e.kind !== 'duplicate') throw e;
    // 409 duplicate: el id ya existe (reintento de un insert que si llego). Se lee para tener el
    // etag/updated reales y se verifica que es NUESTRO evento (misma marca).
    created = false;
    body = await callGoogle(
      env,
      'insert_get',
      () => getEventRequest(token, input.calendarId, eventId),
      opts,
    );
    const item = parseGoogleEvent(body);
    if (item.kind === 'cancelled') throw new GoogleWriteError('gone', 409, 'duplicate');
    if (item.kind !== 'event' || item.event.organizadorId !== input.localId) {
      throw new GoogleWriteError('duplicate', 409, 'duplicate');
    }
  }
  const event = parseResponse(body, 'insert');
  if (event.id !== eventId) throw new GoogleWriteError('bad_response');
  await applyGoogleEvent(env.DB, input.calendarId, event, {
    localId: input.localId,
    pending: opts.pending,
  });
  return { created, event };
}

/** Modifica campos de un evento con If-Match. 412 -> GoogleWriteError('conflict'). */
export async function patchEvent(
  env: Env,
  input: PatchInput,
  opts: WriteOptions = {},
): Promise<{ event: ParsedEvent }> {
  await ensureWritable(env, input.calendarId);
  checkEventId(input.eventId);
  checkEtag(input.etag);
  const payload = buildPayload(input.fields, 'patch', { timeZone: tzOf(env) });
  const token = await getAccessToken(env);
  const body = await callGoogle(
    env,
    'patch',
    () => patchEventRequest(token, input.calendarId, input.eventId, input.etag, payload),
    opts,
  );
  const event = parseResponse(body, 'patch');
  if (event.id !== input.eventId) throw new GoogleWriteError('bad_response');
  await applyGoogleEvent(env.DB, input.calendarId, event, { pending: opts.pending });
  return { event };
}

/** Borra un evento con If-Match. 410/404 (ya borrado) = exito. 412 -> conflict. */
export async function deleteEvent(
  env: Env,
  input: DeleteInput,
  opts: WriteOptions = {},
): Promise<DeleteResult> {
  await ensureWritable(env, input.calendarId);
  checkEventId(input.eventId);
  checkEtag(input.etag);
  const token = await getAccessToken(env);
  let alreadyDeleted = false;
  try {
    await callGoogle(
      env,
      'delete',
      () => deleteEventRequest(token, input.calendarId, input.eventId, input.etag),
      opts,
    );
  } catch (e) {
    if (!(e instanceof GoogleWriteError) || (e.kind !== 'gone' && e.kind !== 'not_found')) {
      throw e;
    }
    alreadyDeleted = true;
  }
  await applyGoogleDelete(env.DB, input.calendarId, input.eventId, { pending: opts.pending });
  return { alreadyDeleted };
}

/**
 * Lee la version actual de un evento en Google (p. ej. tras un 412, para devolverla al cliente).
 * null si ya no existe (404/410/cancelado). No escribe en D1.
 */
export async function getEvent(
  env: Env,
  calendarId: string,
  eventId: string,
  opts: WriteOptions = {},
): Promise<ParsedEvent | null> {
  checkEventId(eventId);
  const token = await getAccessToken(env);
  let body: unknown;
  try {
    body = await callGoogle(env, 'get', () => getEventRequest(token, calendarId, eventId), opts);
  } catch (e) {
    if (e instanceof GoogleWriteError && (e.kind === 'gone' || e.kind === 'not_found')) return null;
    throw e;
  }
  const item = parseGoogleEvent(body);
  if (item.kind === 'cancelled') return null;
  if (item.kind !== 'event') throw new GoogleWriteError('bad_response');
  return item.event;
}

export { GoogleApiError, GoogleWriteError };
