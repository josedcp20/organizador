import { now } from '../clock';
import type { ParsedEvent } from '../sync/parse';

/**
 * Aplicacion a D1 de la RESPUESTA de Google tras una escritura confirmada (T2.10) y estado
 * optimista/pendiente de las escrituras de la app (T3.7).
 *
 * Contrato con el motor de sync (T2.4/T2.5): la purga de fin de pasada completa solo protege las
 * filas que tienen `pending_op` o un `updated` de Google posterior al inicio de la pasada. Por eso,
 * al limpiar `pending_op` se guarda SIEMPRE el `updated` (y el etag del body) que devuelve Google:
 * una escritura terminada a mitad de una pasada completa no es purgada como "no vista". Mientras
 * una escritura esta en vuelo su fila lleva `pending_op`, asi que el sync no la pisa ni la borra.
 *
 * Solo campos del evento de Google (los de `ParsedEvent`); nunca datos privados (event_meta).
 */

const COLS =
  'calendar_id, id, recurring_event_id, status, summary, location, description, all_day, ' +
  'start_at, end_at, start_date, end_date, html_link, updated, etag, original_start, origin, ' +
  'local_id, pending_op, pending_payload, pending_scope, pending_attempts, pending_since, write_error';

/** local_id = organizadorId salvo que ya lo tenga OTRA fila (indice unico). */
const LOCAL_ID_EXPR =
  'CASE WHEN ?18 IS NULL OR EXISTS (SELECT 1 FROM events e2 WHERE e2.local_id = ?18 ' +
  'AND NOT (e2.calendar_id = ?1 AND e2.id = ?2)) THEN NULL ELSE ?18 END';

/**
 * Upsert de la version confirmada por Google + fin del estado pendiente. No retrocede: si la fila
 * ya tiene un `updated` POSTERIOR (otra version mas nueva ya aplicada), no se pisan sus campos.
 */
const APPLY_SQL = `INSERT INTO events (${COLS})
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
    ${LOCAL_ID_EXPR}, NULL, NULL, NULL, 0, NULL, NULL
  ON CONFLICT(calendar_id, id) DO UPDATE SET
    recurring_event_id = excluded.recurring_event_id, status = excluded.status,
    summary = excluded.summary, location = excluded.location, description = excluded.description,
    all_day = excluded.all_day, start_at = excluded.start_at, end_at = excluded.end_at,
    start_date = excluded.start_date, end_date = excluded.end_date, html_link = excluded.html_link,
    updated = excluded.updated, etag = excluded.etag, original_start = excluded.original_start,
    origin = CASE WHEN excluded.origin = 'app' THEN 'app' ELSE events.origin END,
    local_id = COALESCE(events.local_id, excluded.local_id),
    pending_op = NULL, pending_payload = NULL, pending_scope = NULL, pending_attempts = 0,
    pending_since = NULL, write_error = NULL
  WHERE (events.updated IS NULL OR excluded.updated IS NULL OR events.updated <= excluded.updated)`;

/** La escritura se confirmo aunque la fila tuviera una version mas nueva: fuera el pendiente. */
const CLEAR_PENDING_SQL = `UPDATE events SET pending_op = NULL, pending_payload = NULL,
    pending_scope = NULL, pending_attempts = 0, pending_since = NULL, write_error = NULL
  WHERE calendar_id = ?1 AND id = ?2 AND pending_op IS NOT NULL`;

// ---------------------------------------------------------------------------------------------
// Marca de escritura pendiente (T3.7, CLEAR_PENDING seguro).
//
// Cada escritura de la app marca su fila con (pending_op, pending_since, pending_payload); el
// payload lleva un `writeId` aleatorio, asi que la terna identifica UNA escritura concreta. Al
// confirmar (o revertir) esa escritura solo se toca la fila si sigue teniendo SU marca: una
// escritura posterior (que ya cambio la marca) nunca pierde su pendiente.

export type PendingOp = 'insert' | 'patch' | 'delete';

/** Contenido de `events.pending_payload` (JSON). Solo campos de evento (lista blanca), nunca meta. */
export interface PendingPayload {
  v: 1;
  writeId: string;
  op: PendingOp;
  /** Campos a enviar (insert/patch) ya validados (`EventFields`); T3.10 los reenvia via toGooglePayload. */
  fields?: unknown;
  /** Cola (T3.10): inicio del primer intento de esta escritura, se conserva entre reintentos. */
  queuedAt?: string;
}

export interface PendingMarker {
  op: PendingOp;
  since: string;
  payload: string;
}

export function newPendingMarker(
  op: PendingOp,
  fields?: unknown,
  queuedAt?: string,
): PendingMarker {
  const p: PendingPayload = { v: 1, writeId: crypto.randomUUID(), op };
  if (fields !== undefined) p.fields = fields;
  if (queuedAt !== undefined) p.queuedAt = queuedAt;
  return { op, since: new Date(now()).toISOString(), payload: JSON.stringify(p) };
}

/** Payload pendiente de una fila (null si no hay o no es del formato v1). */
export function parsePendingPayload(raw: string | null): PendingPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PendingPayload;
    return p && p.v === 1 && typeof p.writeId === 'string' ? p : null;
  } catch {
    return null;
  }
}

/**
 * Escritura EN VUELO vs pendiente "en cola" (concurrencia, T3.7).
 *
 * Una marca pendiente puede ser de una peticion que aun esta hablando con Google (en vuelo) o de una
 * que ya termino sin confirmar (fallo transitorio/incierto: `recordPendingFailure` deja
 * `write_error` no nulo). Solo sobre la segunda se puede fusionar/reescribir: si otra peticion
 * tomara la fila mientras la primera sigue en vuelo, la confirmacion de la primera solo adoptaria
 * el etag (ADOPT_ETAG) y la segunda acabaria con If-Match gastado (412 -> conflicto falso) o, si
 * Google la rechazara, `revertWrite` resucitaria la marca de la primera ya confirmada (fila
 * atascada). Por eso, con una escritura en vuelo, las demas responden 409 `write_pending`.
 *
 * En vuelo = `pending_op` no nulo, `write_error` nulo y `pending_since` reciente. El limite de
 * antiguedad evita que una peticion que murio a medias (limite de CPU, despliegue...) bloquee la fila
 * para siempre: el peor caso de una escritura en linea es ~80 s (token + 3 intentos de 10 s + esperas
 * + lectura tras 412), muy por debajo de IN_FLIGHT_STALE_MS.
 * Contrato con la cola (T3.10): al tomar una fila para reintentar debe poner su propia marca nueva
 * (pending_since = ahora, write_error = NULL) con el compare-and-swap de `markChange`, y al fallar
 * registrar el fallo con `recordPendingFailure` (write_error no nulo).
 */
export const IN_FLIGHT_STALE_MS = 3 * 60_000;

/** pending_since por debajo del cual una marca sin error se considera abandonada (no en vuelo). */
const staleBefore = (nowMs: number) => new Date(nowMs - IN_FLIGHT_STALE_MS).toISOString();

export function isWriteInFlight(
  r: { pending_op: string | null; write_error: string | null; pending_since: string | null },
  nowMs: number = now(),
): boolean {
  return (
    r.pending_op !== null &&
    r.write_error === null &&
    r.pending_since !== null &&
    r.pending_since > staleBefore(nowMs)
  );
}

/** Condicion SQL "la fila tiene ESTA marca" (parametros ?a, ?b, ?c). */
const markIs = (a: number, b: number, c: number, p = '') =>
  `${p}pending_op = ?${a} AND ${p}pending_since = ?${b} AND ${p}pending_payload = ?${c}`;

/** Igual que APPLY_SQL, pero solo pisa la fila si no tiene pendiente o tiene ESTA marca. */
const APPLY_GUARDED_SQL = `${APPLY_SQL}
    AND (events.pending_op IS NULL OR (${markIs(19, 20, 21, 'events.')}))`;

const CLEAR_GUARDED_SQL = `UPDATE events SET pending_op = NULL, pending_payload = NULL,
    pending_scope = NULL, pending_attempts = 0, pending_since = NULL, write_error = NULL
  WHERE calendar_id = ?1 AND id = ?2 AND ${markIs(3, 4, 5)}`;

/**
 * Otra escritura posterior sigue pendiente: no se tocan sus valores optimistas ni su marca, pero se
 * adopta el etag/updated confirmados (son la base correcta para su If-Match y protegen de la purga).
 */
const ADOPT_ETAG_SQL = `UPDATE events SET etag = ?3, updated = ?4
  WHERE calendar_id = ?1 AND id = ?2 AND pending_op IS NOT NULL
    AND NOT (${markIs(5, 6, 7)})
    AND (updated IS NULL OR ?4 IS NULL OR updated <= ?4)`;

export interface ApplyOptions {
  /** organizadorId conocido por la app (insert): marca la fila como origin='app'. */
  localId?: string | null;
  /**
   * Marca de la escritura que se confirma. Con ella solo se limpia el pendiente si la fila sigue
   * teniendo ESA marca (nunca se borra un pendiente posterior). Sin ella (uso legado de T2.10) se
   * limpia cualquier pendiente: las rutas (T3.7) y la cola (T3.10) deben pasarla siempre.
   */
  pending?: PendingMarker;
}

/** Guarda en `events` el evento devuelto por Google (insert/patch/get) y limpia el pendiente. */
export async function applyGoogleEvent(
  db: D1Database,
  calendarId: string,
  ev: ParsedEvent,
  opts: ApplyOptions = {},
): Promise<void> {
  const localId = ev.organizadorId ?? opts.localId ?? null;
  const params = [
    calendarId,
    ev.id,
    ev.recurringEventId,
    ev.status,
    ev.summary,
    ev.location,
    ev.description,
    ev.allDay ? 1 : 0,
    ev.startAt,
    ev.endAt,
    ev.startDate,
    ev.endDate,
    ev.htmlLink,
    ev.updated,
    ev.etag,
    ev.originalStart,
    localId ? 'app' : 'google',
    localId,
  ];
  const m = opts.pending;
  if (!m) {
    await db.batch([
      db.prepare(APPLY_SQL).bind(...params),
      db.prepare(CLEAR_PENDING_SQL).bind(calendarId, ev.id),
    ]);
    return;
  }
  await db.batch([
    db.prepare(APPLY_GUARDED_SQL).bind(...params, m.op, m.since, m.payload),
    db
      .prepare(ADOPT_ETAG_SQL)
      .bind(calendarId, ev.id, ev.etag, ev.updated, m.op, m.since, m.payload),
    db.prepare(CLEAR_GUARDED_SQL).bind(calendarId, ev.id, m.op, m.since, m.payload),
  ]);
}

/**
 * Borrado confirmado por Google (204, o 404/410 = ya no existe): se quita la fila de `events`.
 * `event_meta` NO se toca aqui (la ruta de T3.7 borra la meta de instancia cuando procede).
 * Con `pending`, solo se borra si la fila no tiene pendiente o sigue teniendo ESA marca: una
 * escritura posterior que ya tomo la fila resuelve ella misma su resultado (no se le quita la fila).
 */
export async function applyGoogleDelete(
  db: D1Database,
  calendarId: string,
  eventId: string,
  opts: { pending?: PendingMarker } = {},
): Promise<void> {
  const m = opts.pending;
  if (!m) {
    await db
      .prepare('DELETE FROM events WHERE calendar_id = ?1 AND id = ?2')
      .bind(calendarId, eventId)
      .run();
    return;
  }
  await db
    .prepare(
      `DELETE FROM events WHERE calendar_id = ?1 AND id = ?2
         AND (pending_op IS NULL OR (${markIs(3, 4, 5)}))`,
    )
    .bind(calendarId, eventId, m.op, m.since, m.payload)
    .run();
}

/**
 * Google respondio 403 de permiso al escribir: el calendario deja de ofrecerse como escribible
 * (GET /api/calendars `writable`, formularios) hasta que el siguiente import de calendarList
 * refresque el rol real. Solo baja owner/writer a 'reader'; nunca sube permisos.
 */
export async function markCalendarReadOnly(db: D1Database, calendarId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE calendars SET access_role = 'reader'
       WHERE id = ?1 AND access_role IN ('owner', 'writer')`,
    )
    .bind(calendarId)
    .run();
}

/** Rol de acceso del calendario presente en D1; undefined si no existe o desaparecio de Google. */
export async function calendarAccessRole(
  db: D1Database,
  calendarId: string,
): Promise<string | null | undefined> {
  const row = await db
    .prepare('SELECT access_role FROM calendars WHERE id = ?1 AND removed_at IS NULL')
    .bind(calendarId)
    .first<{ access_role: string | null }>();
  return row ? row.access_role : undefined;
}

// ---------------------------------------------------------------------------------------------
// Fila de `events` para las escrituras de la app y actualizacion optimista (T3.7).

export interface WriteRow {
  calendar_id: string;
  id: string;
  recurring_event_id: string | null;
  status: string;
  summary: string | null;
  location: string | null;
  description: string | null;
  all_day: number;
  start_at: string | null;
  end_at: string | null;
  start_date: string | null;
  end_date: string | null;
  etag: string | null;
  updated: string | null;
  origin: string;
  local_id: string | null;
  pending_op: PendingOp | null;
  pending_payload: string | null;
  pending_scope: string | null;
  pending_attempts: number;
  pending_since: string | null;
  write_error: string | null;
}

const WRITE_ROW_COLS =
  'calendar_id, id, recurring_event_id, status, summary, location, description, all_day, ' +
  'start_at, end_at, start_date, end_date, etag, updated, origin, local_id, pending_op, ' +
  'pending_payload, pending_scope, pending_attempts, pending_since, write_error';

export async function loadWriteRow(
  db: D1Database,
  calendarId: string,
  eventId: string,
): Promise<WriteRow | null> {
  return await db
    .prepare(`SELECT ${WRITE_ROW_COLS} FROM events WHERE calendar_id = ?1 AND id = ?2`)
    .bind(calendarId, eventId)
    .first<WriteRow>();
}

/**
 * Filas con escritura pendiente que la cola (T3.10) puede reintentar, la marca mas antigua primero.
 * Reintentable = sin error (en vuelo o peticion muerta: la cola filtra por antiguedad) o con un fallo
 * transitorio ('transient', 'not_connected'). El resto ('forbidden', 'conflict', 'rejected',
 * 'duplicate', 'expired') es definitivo y no se vuelve a enviar.
 */
export async function listQueuedWrites(db: D1Database, limit: number): Promise<WriteRow[]> {
  const r = await db
    .prepare(
      `SELECT ${WRITE_ROW_COLS} FROM events WHERE pending_op IS NOT NULL
         AND (write_error IS NULL OR write_error IN ('transient', 'not_connected'))
       ORDER BY pending_since LIMIT ?1`,
    )
    .bind(limit)
    .all<WriteRow>();
  return r.results;
}

/** Fila (de cualquier calendario) que ya usa este organizadorId. */
export async function rowByLocalId(
  db: D1Database,
  localId: string,
): Promise<{ calendar_id: string; id: string } | null> {
  return await db
    .prepare('SELECT calendar_id, id FROM events WHERE local_id = ?1')
    .bind(localId)
    .first<{ calendar_id: string; id: string }>();
}

export type DisplayTime =
  | { allDay: true; startDate: string; endDate: string }
  | { allDay: false; startAt: string; endAt: string };

/** Valores de evento tal y como se guardan en D1 (vista optimista). Ausente = no cambia. */
export interface DisplayValues {
  summary?: string | null;
  location?: string | null;
  description?: string | null;
  time?: DisplayTime;
}

/**
 * Alta optimista de un evento de la app con pending_op='insert'. Si la fila ya existe solo se
 * reescribe si sigue pendiente de insert con el mismo organizadorId (reintento del mismo POST) Y ese
 * alta anterior ya no esta en vuelo (fallo registrado o marca abandonada, ver isWriteInFlight).
 * Devuelve false si no se escribio.
 */
export async function markInsert(
  db: D1Database,
  calendarId: string,
  eventId: string,
  localId: string,
  v: DisplayValues & { time: DisplayTime },
  m: PendingMarker,
): Promise<boolean> {
  const t = v.time;
  const r = await db
    .prepare(
      `INSERT INTO events (calendar_id, id, status, summary, location, description, all_day,
         start_at, end_at, start_date, end_date, origin, local_id, pending_op, pending_payload,
         pending_attempts, pending_since, write_error)
       VALUES (?1, ?2, 'confirmed', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'app', ?11, ?12, ?13, 0, ?14, NULL)
       ON CONFLICT(calendar_id, id) DO UPDATE SET
         summary = excluded.summary, location = excluded.location,
         description = excluded.description, all_day = excluded.all_day,
         start_at = excluded.start_at, end_at = excluded.end_at,
         start_date = excluded.start_date, end_date = excluded.end_date,
         pending_payload = excluded.pending_payload, pending_since = excluded.pending_since,
         write_error = NULL
       WHERE events.pending_op = 'insert' AND events.local_id = excluded.local_id
         AND (events.write_error IS NOT NULL OR events.pending_since IS NULL
              OR events.pending_since <= ?15)`,
    )
    .bind(
      calendarId,
      eventId,
      v.summary ?? null,
      v.location ?? null,
      v.description ?? null,
      t.allDay ? 1 : 0,
      t.allDay ? null : t.startAt,
      t.allDay ? null : t.endAt,
      t.allDay ? t.startDate : null,
      t.allDay ? t.endDate : null,
      localId,
      m.op,
      m.payload,
      m.since,
      staleBefore(Date.parse(m.since)),
    )
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Patch o delete optimista: aplica los valores (patch) y pone ESTA marca, solo si la fila no cambio
 * desde que se leyo (misma marca pendiente y mismo etag: compare-and-swap). false = otra escritura
 * o el sync la cambio entre medias. `attempts`: intentos ya hechos (la cola de T3.10 los conserva).
 */
export async function markChange(
  db: D1Database,
  row: WriteRow,
  v: DisplayValues,
  m: PendingMarker,
  attempts = 0,
): Promise<boolean> {
  const sets = [
    'pending_op = ?7',
    'pending_payload = ?8',
    'pending_since = ?9',
    "pending_scope = 'instance'",
    'write_error = NULL',
  ];
  const vals: unknown[] = [];
  const set = (col: string, val: unknown) => {
    vals.push(val);
    sets.push(`${col} = ?${9 + vals.length}`);
  };
  set('pending_attempts', attempts);
  if (v.summary !== undefined) set('summary', v.summary);
  if (v.location !== undefined) set('location', v.location);
  if (v.description !== undefined) set('description', v.description);
  if (v.time) {
    const t = v.time;
    set('all_day', t.allDay ? 1 : 0);
    set('start_at', t.allDay ? null : t.startAt);
    set('end_at', t.allDay ? null : t.endAt);
    set('start_date', t.allDay ? t.startDate : null);
    set('end_date', t.allDay ? t.endDate : null);
  }
  const r = await db
    .prepare(
      `UPDATE events SET ${sets.join(', ')}
       WHERE calendar_id = ?1 AND id = ?2 AND pending_op IS ?3 AND pending_since IS ?4
         AND pending_payload IS ?5 AND etag IS ?6`,
    )
    .bind(
      row.calendar_id,
      row.id,
      row.pending_op,
      row.pending_since,
      row.pending_payload,
      row.etag,
      m.op,
      m.payload,
      m.since,
      ...vals,
    )
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Deshace la escritura de ESTA marca (Google la rechazo sin aplicarla): sin fila previa (insert)
 * se borra la fila; con fila previa (patch/delete) se restaura tal y como se leyo, incluido su
 * pendiente anterior si lo habia. Si otra escritura ya cambio la marca, no se toca nada.
 *
 * Nunca resucita una marca ajena ya confirmada: si el etag de la fila ya no es el que se leyo, otra
 * escritura se confirmo mientras esta estaba en vuelo (ADOPT_ETAG): se restauran los valores pero el
 * pendiente anterior se da por resuelto (se limpia) y se conserva el etag/updated adoptados.
 * `writeError` (p. ej. 'forbidden') se guarda en `write_error` para que la UI vea el motivo.
 */
export async function revertWrite(
  db: D1Database,
  before: WriteRow | null,
  calendarId: string,
  eventId: string,
  m: PendingMarker,
  opts: { writeError?: string } = {},
): Promise<void> {
  if (!before) {
    await db
      .prepare(`DELETE FROM events WHERE calendar_id = ?1 AND id = ?2 AND ${markIs(3, 4, 5)}`)
      .bind(calendarId, eventId, m.op, m.since, m.payload)
      .run();
    return;
  }
  const b = before;
  await db
    .prepare(
      `UPDATE events SET summary = ?6, location = ?7, description = ?8, all_day = ?9,
         start_at = ?10, end_at = ?11, start_date = ?12, end_date = ?13,
         pending_op = CASE WHEN etag IS ?20 THEN ?14 ELSE NULL END,
         pending_payload = CASE WHEN etag IS ?20 THEN ?15 ELSE NULL END,
         pending_scope = CASE WHEN etag IS ?20 THEN ?16 ELSE NULL END,
         pending_attempts = CASE WHEN etag IS ?20 THEN ?17 ELSE 0 END,
         pending_since = CASE WHEN etag IS ?20 THEN ?18 ELSE NULL END,
         write_error = COALESCE(?21, CASE WHEN etag IS ?20 THEN ?19 ELSE NULL END)
       WHERE calendar_id = ?1 AND id = ?2 AND ${markIs(3, 4, 5)}`,
    )
    .bind(
      calendarId,
      eventId,
      m.op,
      m.since,
      m.payload,
      b.summary,
      b.location,
      b.description,
      b.all_day,
      b.start_at,
      b.end_at,
      b.start_date,
      b.end_date,
      b.pending_op,
      b.pending_payload,
      b.pending_scope,
      b.pending_attempts,
      b.pending_since,
      b.write_error,
      b.etag,
      opts.writeError ?? null,
    )
    .run();
}

/** Fallo transitorio: la escritura queda en cola (T3.10) con el intento contado y el motivo. */
export async function recordPendingFailure(
  db: D1Database,
  calendarId: string,
  eventId: string,
  m: PendingMarker,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE events SET pending_attempts = pending_attempts + 1, write_error = ?6
       WHERE calendar_id = ?1 AND id = ?2 AND ${markIs(3, 4, 5)}`,
    )
    .bind(calendarId, eventId, m.op, m.since, m.payload, error)
    .run();
}
