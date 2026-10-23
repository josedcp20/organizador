import type { CalendarInfo, CalendarPatch, CalendarsResponse } from '@organizador/shared';
import { apiFetch } from './api';

export function fetchCalendars(): Promise<CalendarsResponse> {
  return apiFetch<CalendarsResponse>('/api/calendars');
}

/** Importa desde Google (el Worker lee calendarList) y devuelve la lista resultante. */
export function refreshCalendars(): Promise<CalendarsResponse> {
  return apiFetch<CalendarsResponse>('/api/calendars/refresh', { method: 'POST' });
}

/** Color y visibilidad se guardan solo en el Worker (D1); nunca se envian a Google. */
export function patchCalendar(id: string, patch: CalendarPatch): Promise<CalendarInfo> {
  return apiFetch<CalendarInfo>(`/api/calendars/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}
