import type {
  CalendarInfo,
  CalendarPatch,
  CalendarsResponse,
  SyncResult,
} from '@organizador/shared';
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

/** `POST /api/sync` (1/min). Los errores llegan como ApiError (429 rate_limited, 409 sync_busy...). */
export function syncNow(): Promise<SyncResult> {
  return apiFetch<SyncResult>('/api/sync', { method: 'POST' });
}

/** "hace X" en espanol a partir de un ISO UTC. Vacio/invalido -> "nunca". */
export function formatAgo(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return 'nunca';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'nunca';
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return 'hace un momento';
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'hace 1 día' : `hace ${d} días`;
}

/** Colores compartidos por 2+ calendarios habilitados (visibles): mapa color -> nombres. */
export function duplicateColors(calendars: CalendarInfo[]): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const c of calendars) {
    if (!c.visible) continue;
    const key = c.color.toLowerCase();
    by.set(key, [...(by.get(key) ?? []), c.name]);
  }
  for (const [k, v] of [...by]) if (v.length < 2) by.delete(k);
  return by;
}

/** Calendarios habilitados con error de sync. */
export function calendarsWithSyncError(calendars: CalendarInfo[]): CalendarInfo[] {
  return calendars.filter((c) => c.visible && !!c.lastSyncError);
}

/** Mensaje amable para los fallos de "Sincronizar ahora". */
export function syncErrorMessage(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'rate_limited') {
    return 'Acabas de sincronizar. Espera un minuto antes de volver a intentarlo.';
  }
  if (code === 'sync_busy') return 'Ya hay una sincronización en curso. Espera un momento.';
  if (code === 'google_not_connected') return 'Google no está conectado.';
  if (code === 'google_unavailable') {
    return 'Google no responde ahora mismo. Inténtalo en unos minutos.';
  }
  return 'No se pudo sincronizar. Inténtalo de nuevo más tarde.';
}
