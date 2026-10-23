import type { ParsedEvent } from '../sync/parse';

/**
 * Aplicacion a D1 de la RESPUESTA de Google tras una escritura confirmada (T2.10).
 *
 * Contrato con el motor de sync (T2.4/T2.5): la purga de fin de pasada completa solo protege las
 * filas que tienen `pending_op` o un `updated` de Google posterior al inicio de la pasada. Por eso,
 * al limpiar `pending_op` se guarda SIEMPRE el `updated` (y el etag del body) que devuelve Google:
 * una escritura terminada a mitad de una pasada completa no es purgada como "no vista".
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
  WHERE events.updated IS NULL OR excluded.updated IS NULL OR events.updated <= excluded.updated`;

/** La escritura se confirmo aunque la fila tuviera una version mas nueva: fuera el pendiente. */
const CLEAR_PENDING_SQL = `UPDATE events SET pending_op = NULL, pending_payload = NULL,
    pending_scope = NULL, pending_attempts = 0, pending_since = NULL, write_error = NULL
  WHERE calendar_id = ?1 AND id = ?2 AND pending_op IS NOT NULL`;

export interface ApplyOptions {
  /** organizadorId conocido por la app (insert): marca la fila como origin='app'. */
  localId?: string | null;
}

/** Guarda en `events` el evento devuelto por Google (insert/patch/get) y limpia el pendiente. */
export async function applyGoogleEvent(
  db: D1Database,
  calendarId: string,
  ev: ParsedEvent,
  opts: ApplyOptions = {},
): Promise<void> {
  const localId = ev.organizadorId ?? opts.localId ?? null;
  await db.batch([
    db
      .prepare(APPLY_SQL)
      .bind(
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
      ),
    db.prepare(CLEAR_PENDING_SQL).bind(calendarId, ev.id),
  ]);
}

/**
 * Borrado confirmado por Google (204, o 404/410 = ya no existe): se quita la fila de `events`.
 * `event_meta` NO se toca aqui (la ruta de T3.7 decide si borra la meta de instancia).
 */
export async function applyGoogleDelete(
  db: D1Database,
  calendarId: string,
  eventId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM events WHERE calendar_id = ?1 AND id = ?2')
    .bind(calendarId, eventId)
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
