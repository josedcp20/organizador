import type { AgendaEventCreate, AgendaEventPatch, EventInfo } from '@organizador/shared';
import { AGENDA_WRITE_LIMITS, addDaysToDateStr, formatDateInTz } from '@organizador/shared';
import { ApiError, apiFetch } from './api';
import { path } from './eventDetail';
import { timeInMadrid } from './events';
import { apiErrorMessage } from './google';

/** Formulario de evento. En dia completo `endDate` es INCLUSIVO (la API lo quiere exclusivo). */
export interface EventForm {
  summary: string;
  location: string;
  description: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

// --- Llamadas a la API (201/200/202 devuelven el evento; DELETE 204) ---

export function createEvent(body: AgendaEventCreate): Promise<EventInfo> {
  return apiFetch<EventInfo>('/api/agenda', { method: 'POST', body });
}

export function updateEvent(
  calendarId: string,
  eventId: string,
  body: AgendaEventPatch,
): Promise<EventInfo> {
  return apiFetch<EventInfo>(path(calendarId, eventId), { method: 'PATCH', body });
}

export function deleteEvent(
  calendarId: string,
  eventId: string,
  confirmExternal: boolean,
): Promise<void> {
  const q = confirmExternal ? '?confirm_external=true' : '';
  return apiFetch<void>(`${path(calendarId, eventId)}${q}`, { method: 'DELETE' });
}

// --- Conversion evento <-> formulario ---

export function formFromEvent(e: EventInfo): EventForm {
  const base = {
    summary: e.summary ?? '',
    location: e.location ?? '',
    description: e.description ?? '',
  };
  if (e.allDay) {
    const startDate = e.startDate ?? '';
    const endDate =
      e.endDate && e.endDate > startDate ? addDaysToDateStr(e.endDate, -1) : startDate;
    return { ...base, allDay: true, startDate, startTime: '', endDate, endTime: '' };
  }
  const start = e.startAt ? new Date(e.startAt) : null;
  const end = e.endAt ? new Date(e.endAt) : start;
  const ok = (d: Date | null): d is Date => !!d && !Number.isNaN(d.getTime());
  return {
    ...base,
    allDay: false,
    startDate: ok(start) ? formatDateInTz(start) : '',
    startTime: ok(start) ? timeInMadrid(start.toISOString()) : '',
    endDate: ok(end) ? formatDateInTz(end) : '',
    endTime: ok(end) ? timeInMadrid(end.toISOString()) : '',
  };
}

/** Inicio: siguiente hora en punto (Madrid); fin: +1 h, recortado a 23:59 si pasaria de medianoche. */
export function defaultForm(date: string, now: Date): EventForm {
  const h = Number(timeInMadrid(now.toISOString()).slice(0, 2));
  const start = Math.min(h + 1, 23);
  const hh = (n: number) => `${String(n).padStart(2, '0')}:00`;
  return {
    summary: '',
    location: '',
    description: '',
    allDay: false,
    startDate: date,
    startTime: hh(start),
    endDate: date,
    endTime: start + 1 > 23 ? '23:59' : hh(start + 1),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Mismos limites de ano que el Worker (agendaInput.ts).
const isDate = (s: string) =>
  DATE_RE.test(s) &&
  +s.slice(0, 4) >= 1970 &&
  +s.slice(0, 4) <= 2100 &&
  addDaysToDateStr(s, 0) === s;
const local = (date: string, time: string) => `${date}T${time}`;

export function validateForm(f: EventForm): string | null {
  const summary = f.summary.trim();
  if (!summary) return 'El título es obligatorio.';
  if (summary.length > AGENDA_WRITE_LIMITS.summaryMax) return 'El título es demasiado largo.';
  if (f.location.trim().length > AGENDA_WRITE_LIMITS.locationMax) {
    return 'La ubicación es demasiado larga.';
  }
  if (f.description.length > AGENDA_WRITE_LIMITS.descriptionMax) {
    return 'La descripción es demasiado larga.';
  }
  if (!isDate(f.startDate) || !isDate(f.endDate)) return 'Las fechas no son válidas.';
  if (f.allDay) {
    return f.endDate < f.startDate ? 'La fecha de fin no puede ser anterior a la de inicio.' : null;
  }
  if (!TIME_RE.test(f.startTime) || !TIME_RE.test(f.endTime)) return 'Las horas no son válidas.';
  return local(f.endDate, f.endTime) < local(f.startDate, f.startTime)
    ? 'El fin no puede ser anterior al inicio.'
    : null;
}

/** Trio allDay/start/end para la API. */
function times(f: EventForm): Pick<AgendaEventCreate, 'allDay' | 'start' | 'end'> {
  return f.allDay
    ? { allDay: true, start: f.startDate, end: addDaysToDateStr(f.endDate, 1) }
    : {
        allDay: false,
        start: local(f.startDate, f.startTime),
        end: local(f.endDate, f.endTime),
      };
}

/** Vacio (solo espacios) -> null. */
const orNull = (s: string) => (s.trim() === '' ? null : s);

export function buildCreate(f: EventForm, calendarId: string, clientId: string): AgendaEventCreate {
  return {
    client_id: clientId,
    calendarId,
    summary: f.summary.trim(),
    location: orNull(f.location.trim()),
    description: orNull(f.description),
    ...times(f),
  };
}

/**
 * Diff contra el formulario inicial. null = sin cambios. Nunca cambia `allDay` (la UI lo bloquea).
 * `orig`: instantes originales; si inicio/fin no cambian se reenvian tal cual (con Z) porque la hora
 * local puede ser ambigua en el cambio de hora de otono (el Worker tomaria la segunda ocurrencia).
 */
export function buildPatch(
  initial: EventForm,
  f: EventForm,
  orig?: Pick<EventInfo, 'startAt' | 'endAt'>,
): AgendaEventPatch | null {
  const patch: AgendaEventPatch = {};
  if (f.summary.trim() !== initial.summary.trim()) patch.summary = f.summary.trim();
  if (f.location.trim() !== initial.location.trim()) patch.location = orNull(f.location.trim());
  if (f.description !== initial.description) patch.description = orNull(f.description);
  const dateChanged = initial.allDay
    ? f.startDate !== initial.startDate || f.endDate !== initial.endDate
    : f.startDate !== initial.startDate ||
      f.startTime !== initial.startTime ||
      f.endDate !== initial.endDate ||
      f.endTime !== initial.endTime;
  if (dateChanged) {
    const t = times({ ...f, allDay: initial.allDay });
    if (!initial.allDay && orig) {
      const sameStart = f.startDate === initial.startDate && f.startTime === initial.startTime;
      const sameEnd = f.endDate === initial.endDate && f.endTime === initial.endTime;
      const origEnd = orig.endAt ?? orig.startAt;
      if (sameStart && orig.startAt) t.start = orig.startAt;
      if (sameEnd && origEnd) t.end = origEnd;
    }
    Object.assign(patch, t);
  }
  return Object.keys(patch).length ? patch : null;
}

// --- Errores ---

const INVALID = 'Revisa el formulario: algún dato no es válido.';
const GONE = 'El evento ya no existe en Google.';
const MESSAGES: Record<string, string> = {
  calendar_forbidden: 'No tienes permiso en este calendario.',
  frozen: 'No se pueden crear ni mover eventos a fechas de hace más de un mes.',
  confirmation_required:
    'Este evento no lo creaste en la app; hay que confirmar el cambio en Google Calendar.',
  conflict: 'El evento ha cambiado en Google Calendar.',
  duplicate: 'Este evento ya se había guardado. Vuelve a guardar.',
  not_found: GONE,
  gone: GONE,
  google_not_connected: 'Google no está conectado. Conéctalo en Ajustes.',
  recurring_not_supported: 'Los eventos recurrentes se editan desde Google Calendar.',
  validation: INVALID,
  google_rejected: 'Google rechazó los datos. Revisa el formulario.',
};

export function writeErrorMessage(e: unknown): { text: string; retry: boolean } {
  if (e instanceof ApiError) {
    if (e.code === 'network' || e.status === 502) {
      return { text: 'No se pudo contactar con Google.', retry: true };
    }
    if (e.code === 'write_pending') {
      return {
        text: 'Hay un cambio anterior enviándose a Google. Espera unos segundos y vuelve a intentarlo.',
        retry: true,
      };
    }
    const text = MESSAGES[e.code] ?? (e.status === 400 ? INVALID : undefined);
    if (text) return { text, retry: false };
  }
  return { text: apiErrorMessage(e), retry: false };
}

/** `current` del 409 conflict: EventInfo, null (ya no visible) o undefined (no es un conflicto). */
export function conflictCurrent(e: unknown): EventInfo | null | undefined {
  if (!(e instanceof ApiError) || e.status !== 409 || e.code !== 'conflict') return undefined;
  const current = (e.body as { current?: EventInfo | null } | undefined)?.current;
  return current ?? null;
}
