import type { EventInfo, TodayResponse } from '@organizador/shared';
import { formatDateInTz } from '@organizador/shared';
import { apiFetch } from './api';

export function fetchToday(): Promise<TodayResponse> {
  return apiFetch<TodayResponse>('/api/today');
}

export interface EventRow {
  id: string;
  calendarId: string;
  eventId: string;
  remind: boolean;
  hasNotes: boolean;
  done: boolean;
  time: string;
  title: string;
  location: string | null;
  color: string;
  fromApp: boolean;
  pending: boolean;
  pendingError: string | null;
  tentative: boolean;
}

const timeFmt = new Intl.DateTimeFormat('es-ES', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Madrid',
});

/**
 * Hora de un evento. `day` (YYYY-MM-DD, Europe/Madrid) es el dia en que se muestra; permite
 * describir bien los eventos con hora que ocupan varios dias.
 */
export function formatEventTime(e: EventInfo, day?: string): string {
  if (e.allDay || !e.startAt) return 'Todo el día';
  const startDate = new Date(e.startAt);
  const start = timeFmt.format(startDate);
  if (!e.endAt) return start;
  const endDate = new Date(e.endAt);
  const end = timeFmt.format(endDate);
  if (day && !Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime())) {
    const startDay = formatDateInTz(startDate);
    // Un evento que acaba a las 00:00 exactas no ocupa ese dia
    const endDay =
      endDate.getTime() > startDate.getTime()
        ? formatDateInTz(new Date(endDate.getTime() - 1))
        : startDay;
    if (startDay < day && endDay > day) return 'Todo el día';
    if (startDay < day && endDay === day) return `hasta ${end}`;
    if (startDay === day && endDay > day) return `desde ${start}`;
  }
  return `${start} - ${end}`;
}

export function toRow(e: EventInfo, day?: string): EventRow {
  return {
    id: `${e.calendarId}/${e.id}`,
    calendarId: e.calendarId,
    eventId: e.id,
    remind: e.remind === true,
    hasNotes: typeof e.notes === 'string' && e.notes.trim() !== '',
    done: e.done === true,
    time: formatEventTime(e, day),
    title: e.summary?.trim() || '(Sin título)',
    location: e.location?.trim() || null,
    color: e.color,
    fromApp: e.origin === 'app',
    pending: e.pending !== null && e.pending !== undefined,
    pendingError: e.pending?.error ?? null,
    tentative: e.status === 'tentative',
  };
}

export function toRows(events: EventInfo[], day?: string): EventRow[] {
  return events.map((e) => toRow(e, day));
}
