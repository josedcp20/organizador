import type { EventInfo, EventsResponse } from '@organizador/shared';
import { addDaysToDateStr, addMonthsToDateStr, formatDateInTz } from '@organizador/shared';
import { apiFetch } from './api';

const TZ = 'Europe/Madrid';

export type CalView = 'month' | 'week' | 'agenda';

/** Evento listo para pintar. Todas las fechas son dias de Europe/Madrid (YYYY-MM-DD). */
export interface CalEvent {
  id: string;
  calendarId: string;
  title: string;
  color: string;
  allDay: boolean;
  /** Primer dia que ocupa. */
  startDay: string;
  /** Ultimo dia que ocupa (INCLUSIVO; en dia completo se resta el dia exclusivo de Google). */
  endDay: string;
  /** HH:MM Madrid (null en dia completo). */
  startTime: string | null;
  endTime: string | null;
  multiDay: boolean;
  tentative: boolean;
  fromApp: boolean;
  pending: boolean;
  /** Mensaje de la escritura fallida, si lo hay. */
  pendingError: string | null;
  location: string | null;
  /** Avisar activado (valor resuelto). */
  remind: boolean;
  /** Tiene notas privadas no vacias (valor resuelto). */
  hasNotes: boolean;
}

const timeFmt = new Intl.DateTimeFormat('es-ES', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function timeInMadrid(iso: string): string {
  return timeFmt.format(new Date(iso));
}

/** Funcion pura EventInfo -> CalEvent. Devuelve null si faltan fechas validas. */
export function mapEvent(e: EventInfo): CalEvent | null {
  let startDay: string;
  let endDay: string;
  let startTime: string | null = null;
  let endTime: string | null = null;

  if (e.allDay) {
    if (!e.startDate) return null;
    startDay = e.startDate;
    // endDate es exclusivo
    endDay = e.endDate && e.endDate > e.startDate ? addDaysToDateStr(e.endDate, -1) : e.startDate;
  } else {
    if (!e.startAt) return null;
    const start = new Date(e.startAt);
    if (Number.isNaN(start.getTime())) return null;
    startDay = formatDateInTz(start);
    startTime = timeInMadrid(e.startAt);
    endDay = startDay;
    if (e.endAt) {
      const end = new Date(e.endAt);
      if (!Number.isNaN(end.getTime())) {
        endTime = timeInMadrid(e.endAt);
        // Un evento que acaba a las 00:00 exactas no ocupa ese dia
        if (end.getTime() > start.getTime()) {
          const last = formatDateInTz(new Date(end.getTime() - 1));
          if (last > startDay) endDay = last;
        }
      }
    }
  }

  return {
    id: e.id,
    calendarId: e.calendarId,
    title: e.summary?.trim() || '(sin titulo)',
    color: e.color,
    allDay: e.allDay,
    startDay,
    endDay,
    startTime,
    endTime,
    multiDay: endDay > startDay,
    tentative: e.status === 'tentative',
    fromApp: e.origin === 'app',
    pending: e.pending !== null,
    pendingError: e.pending?.error ?? null,
    location: e.location,
    remind: e.remind === true,
    hasNotes: typeof e.notes === 'string' && e.notes.trim() !== '',
  };
}

/**
 * Hora de un evento CON hora para el dia `day` en que se pinta (mismo criterio que
 * `formatEventTime` de today.ts). Dia completo -> ''. Compacto: solo la hora de inicio si empieza
 * ese dia; en los demas dias de un multi-dia, vacio.
 */
export function eventTimeLabel(e: CalEvent, day?: string, compact = false): string {
  if (e.allDay || !e.startTime) return '';
  if (day && e.multiDay) {
    if (e.startDay < day && e.endDay > day) return compact ? '' : 'Todo el día';
    if (e.startDay < day && e.endDay === day) {
      return compact || !e.endTime ? '' : `hasta ${e.endTime}`;
    }
    if (e.startDay === day && e.endDay > day) return compact ? e.startTime : `desde ${e.startTime}`;
  }
  return compact || !e.endTime ? e.startTime : `${e.startTime} - ${e.endTime}`;
}

export function mapEvents(list: EventInfo[]): CalEvent[] {
  const out: CalEvent[] = [];
  for (const e of list) {
    const m = mapEvent(e);
    if (m) out.push(m);
  }
  return out;
}

export interface EventFilter {
  /** Calendarios ocultos por el usuario. */
  hiddenCalendars: ReadonlySet<string>;
  /** Mostrar eventos con origin='app'. */
  showApp: boolean;
}

export function filterEvents(events: CalEvent[], f: EventFilter): CalEvent[] {
  return events.filter((e) => !f.hiddenCalendars.has(e.calendarId) && (f.showApp || !e.fromApp));
}

function cmpEvents(a: CalEvent, b: CalEvent): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.allDay) return a.title.localeCompare(b.title, 'es');
  return (
    (a.startTime ?? '').localeCompare(b.startTime ?? '') || a.title.localeCompare(b.title, 'es')
  );
}

/**
 * Agrupa por dia dentro de [from, to] (inclusivo). Un evento multi-dia aparece en cada dia que
 * toca. Cada dia ordenado: dia completo primero, luego por hora.
 */
export function groupByDay(events: CalEvent[], from: string, to: string): Map<string, CalEvent[]> {
  const map = new Map<string, CalEvent[]>();
  for (const e of events) {
    const first = e.startDay < from ? from : e.startDay;
    const last = e.endDay > to ? to : e.endDay;
    for (let d = first; d <= last; d = addDaysToDateStr(d, 1)) {
      const arr = map.get(d);
      if (arr) arr.push(e);
      else map.set(d, [e]);
    }
  }
  for (const arr of map.values()) arr.sort(cmpEvents);
  return map;
}

/** 0 = lunes ... 6 = domingo. */
export function weekdayIndex(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function startOfWeek(dateStr: string): string {
  return addDaysToDateStr(dateStr, -weekdayIndex(dateStr));
}

export function startOfMonth(dateStr: string): string {
  return `${dateStr.slice(0, 7)}-01`;
}

export const AGENDA_DAYS = 30;

/** Rango (inclusivo) que pinta la vista para la fecha ancla. */
export function visibleRange(view: CalView, anchor: string): { from: string; to: string } {
  if (view === 'week') {
    const from = startOfWeek(anchor);
    return { from, to: addDaysToDateStr(from, 6) };
  }
  if (view === 'agenda') {
    return { from: anchor, to: addDaysToDateStr(anchor, AGENDA_DAYS - 1) };
  }
  // Mes: 6 semanas completas desde el lunes de la semana del dia 1
  const from = startOfWeek(startOfMonth(anchor));
  return { from, to: addDaysToDateStr(from, 41) };
}

/** Rango a pedir al servidor: el visible con margen (dias) a cada lado. */
export function fetchRange(
  view: CalView,
  anchor: string,
  marginDays = 7,
): { from: string; to: string } {
  const r = visibleRange(view, anchor);
  return { from: addDaysToDateStr(r.from, -marginDays), to: addDaysToDateStr(r.to, marginDays) };
}

/** Nueva fecha ancla tras pulsar anterior (-1) / siguiente (+1). */
export function shiftAnchor(view: CalView, anchor: string, dir: -1 | 1): string {
  if (view === 'week') return addDaysToDateStr(anchor, 7 * dir);
  if (view === 'agenda') return addDaysToDateStr(anchor, 14 * dir);
  return addMonthsToDateStr(startOfMonth(anchor), dir);
}

export function todayMadrid(now: Date = new Date()): string {
  return formatDateInTz(now);
}

/** Vista por defecto: agenda en movil (<700px), mes en escritorio. */
export function defaultView(width: number): CalView {
  return width < 700 ? 'agenda' : 'month';
}

function utcNoon(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

const dayFmt = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const shortFmt = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
});
const monthFmt = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'UTC',
  month: 'long',
  year: 'numeric',
});

export function formatDayLong(dateStr: string): string {
  return dayFmt.format(utcNoon(dateStr));
}

export function formatDayShort(dateStr: string): string {
  return shortFmt.format(utcNoon(dateStr));
}

export function periodTitle(view: CalView, anchor: string): string {
  if (view === 'month') return monthFmt.format(utcNoon(anchor));
  const { from, to } = visibleRange(view, anchor);
  return `${formatDayShort(from)} - ${formatDayShort(to)}`;
}

export function fetchEvents(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<EventsResponse> {
  return apiFetch<EventsResponse>(`/api/agenda?from=${from}&to=${to}`, { signal });
}
