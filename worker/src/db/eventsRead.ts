import { CALENDAR_PALETTE, addDaysToDateStr, startOfDateInTz } from '@organizador/shared';
import type { EventInfo } from '@organizador/shared';
import { now } from '../clock';
import { metaValuesFromRow, resolveMeta } from './eventMeta';
import { DEFAULT_TZ, syncWindow } from '../sync/window';

/** Tope defensivo de filas por consulta (un rango de 400 dias no se acerca a esto). */
const MAX_ROWS = 3000;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

interface EventRow {
  id: string;
  calendar_id: string;
  status: string;
  summary: string | null;
  location: string | null;
  description: string | null;
  all_day: number;
  start_at: string | null;
  end_at: string | null;
  start_date: string | null;
  end_date: string | null;
  recurring_event_id: string | null;
  html_link: string | null;
  origin: string;
  pending_op: string | null;
  write_error: string | null;
  access_role: string | null;
  cal_color: string | null;
  cal_google_color: string | null;
  app_color: string | null;
  mi_present: number | null;
  mi_notes: string | null;
  mi_remind: number | null;
  mi_days: number | null;
  mi_color: string | null;
  ms_present: number | null;
  ms_notes: string | null;
  ms_remind: number | null;
  ms_days: number | null;
  ms_color: string | null;
}

export interface ReadOptions {
  /** Instante actual (ms) para calcular `frozen`; por defecto el reloj de la app. */
  nowMs?: number;
  /** Zona horaria; por defecto Europe/Madrid. */
  tz?: string;
}

export interface GetOptions extends ReadOptions {
  /**
   * Respuestas de las escrituras (T3.7): incluye calendarios ocultos y filas con un borrado
   * pendiente (para devolver el `EventInfo` con `pending.op = 'delete'`).
   */
  forWrite?: boolean;
}

const SELECT_BASE = `SELECT e.id, e.calendar_id, e.status, e.summary, e.location, e.description,
              e.all_day, e.start_at, e.end_at, e.start_date, e.end_date, e.recurring_event_id,
              e.html_link, e.origin, e.pending_op, e.write_error, c.access_role,
              c.color AS cal_color, c.google_color AS cal_google_color,
              (SELECT s.value FROM settings s WHERE s.key = 'app_events_color') AS app_color,
              CASE WHEN mi.target_id IS NULL THEN NULL ELSE 1 END AS mi_present,
              mi.notes AS mi_notes, mi.remind AS mi_remind,
              mi.remind_days_before AS mi_days, mi.color AS mi_color,
              CASE WHEN ms.target_id IS NULL THEN NULL ELSE 1 END AS ms_present,
              ms.notes AS ms_notes, ms.remind AS ms_remind,
              ms.remind_days_before AS ms_days, ms.color AS ms_color
       FROM events e
       JOIN calendars c ON c.id = e.calendar_id
       LEFT JOIN event_meta mi
         ON mi.calendar_id = e.calendar_id AND mi.scope = 'instance' AND mi.target_id = e.id
       LEFT JOIN event_meta ms
         ON ms.calendar_id = e.calendar_id AND ms.scope = 'series'
        AND ms.target_id = e.recurring_event_id
       WHERE c.removed_at IS NULL AND e.status != 'cancelled'`;

/** Lectura normal: solo calendarios visibles y sin los borrados pendientes de confirmar. */
const VISIBLE = ` AND c.enabled = 1 AND (e.pending_op IS NULL OR e.pending_op != 'delete')`;

/**
 * Eventos de D1 que solapan con [from, to] (fechas YYYY-MM-DD de Europe/Madrid, ambas inclusivas).
 * Solo calendarios visibles y presentes en Google. Nunca llama a Google. Ordenados por inicio.
 * Metadatos locales (event_meta): campo a campo, instancia > serie > defecto.
 */
export async function listEventsInRange(
  db: D1Database,
  from: string,
  to: string,
  opts: ReadOptions = {},
): Promise<EventInfo[]> {
  const toExDate = addDaysToDateStr(to, 1);
  const fromIso = startOfDateInTz(from).toISOString();
  const toExIso = startOfDateInTz(toExDate).toISOString();

  // Con hora: start < fin_de_rango y (end > inicio_de_rango o, si dura 0, start >= inicio).
  // Dia completo: end_date es exclusivo (Google), igual que toExDate.
  // ORDER BY determinista ANTES del LIMIT: si se llegara al tope, el recorte es estable.
  const { results } = await db
    .prepare(
      `${SELECT_BASE}${VISIBLE}
         AND (
           (e.all_day = 0 AND e.start_at < ?2
             AND (e.end_at > ?1 OR e.start_at >= ?1))
           OR
           (e.all_day = 1 AND e.start_date < ?4
             AND (e.end_date > ?3 OR e.start_date >= ?3))
         )
       ORDER BY CASE WHEN e.all_day = 1 THEN e.start_date ELSE e.start_at END,
                e.calendar_id, e.id
       LIMIT ${MAX_ROWS}`,
    )
    .bind(fromIso, toExIso, from, toExDate)
    .all<EventRow>();

  const win = windowFor(opts);
  const items = results.map((r) => ({ key: sortKey(r), info: toInfo(r, win) }));
  items.sort(
    (a, b) =>
      a.key - b.key ||
      (a.info.summary ?? '').localeCompare(b.info.summary ?? '') ||
      a.info.calendarId.localeCompare(b.info.calendarId) ||
      a.info.id.localeCompare(b.info.id),
  );
  return items.map((i) => i.info);
}

/** Un evento por (calendarId, eventId); null si no existe o su calendario no es visible. */
export async function getEventById(
  db: D1Database,
  calendarId: string,
  eventId: string,
  opts: GetOptions = {},
): Promise<EventInfo | null> {
  const filter = opts.forWrite ? '' : VISIBLE;
  const row = await db
    .prepare(`${SELECT_BASE}${filter} AND e.calendar_id = ?1 AND e.id = ?2`)
    .bind(calendarId, eventId)
    .first<EventRow>();
  return row ? toInfo(row, windowFor(opts)) : null;
}

interface FrozenWindow {
  startDate: string;
  timeMin: string;
}

function windowFor(opts: ReadOptions): FrozenWindow {
  const w = syncWindow(opts.nowMs ?? now(), opts.tz || DEFAULT_TZ);
  return { startDate: w.startDate, timeMin: w.timeMin };
}

function sortKey(r: EventRow): number {
  if (r.all_day === 1 && r.start_date) return startOfDateInTz(r.start_date).getTime();
  return r.start_at ? Date.parse(r.start_at) : 0;
}

/** Misma regla que el motor de sync: inicio anterior a la ventana (NULL cuenta como congelado). */
function isFrozen(r: EventRow, w: FrozenWindow): boolean {
  return r.all_day === 1 ? (r.start_date ?? '') < w.startDate : (r.start_at ?? '') < w.timeMin;
}

function effectiveColor(r: EventRow, metaColor: string | null): string {
  const app = r.app_color && HEX_COLOR.test(r.app_color) ? r.app_color : null;
  const base = r.origin === 'app' ? (app ?? r.cal_color) : r.cal_color;
  return metaColor ?? base ?? r.cal_google_color ?? CALENDAR_PALETTE[0];
}

function toInfo(r: EventRow, w: FrozenWindow): EventInfo {
  const op = r.pending_op;
  const instance = metaValuesFromRow({
    present: r.mi_present,
    notes: r.mi_notes,
    remind: r.mi_remind,
    remind_days_before: r.mi_days,
    color: r.mi_color,
  });
  const series = metaValuesFromRow({
    present: r.ms_present,
    notes: r.ms_notes,
    remind: r.ms_remind,
    remind_days_before: r.ms_days,
    color: r.ms_color,
  });
  const meta = resolveMeta(instance, series);
  return {
    id: r.id,
    calendarId: r.calendar_id,
    color: effectiveColor(r, meta.color),
    status: r.status === 'tentative' ? 'tentative' : 'confirmed',
    summary: r.summary,
    location: r.location,
    description: r.description,
    allDay: r.all_day === 1,
    startAt: r.start_at,
    endAt: r.end_at,
    startDate: r.start_date,
    endDate: r.end_date,
    recurringEventId: r.recurring_event_id,
    htmlLink: r.html_link,
    origin: r.origin === 'app' ? 'app' : 'google',
    notes: meta.notes,
    remind: meta.remind,
    remindDaysBefore: meta.remindDaysBefore,
    writable: r.access_role === 'owner' || r.access_role === 'writer',
    frozen: isFrozen(r, w),
    pending:
      op === 'insert' || op === 'patch' || op === 'delete' ? { op, error: r.write_error } : null,
    metaScopes: { instance, series },
  };
}
