import type {
  EventInfo,
  EventMetaInput,
  EventMetaScope,
  EventMetaValues,
} from '@organizador/shared';
import {
  EVENT_META_LIMITS,
  addDaysToDateStr,
  formatDateInTz,
  isHexColor,
} from '@organizador/shared';
import { apiFetch } from './api';
import { formatDayLong, timeInMadrid } from './events';

export function path(calendarId: string, eventId: string): string {
  return `/api/agenda/${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}`;
}

export function fetchEvent(
  calendarId: string,
  eventId: string,
  signal?: AbortSignal,
): Promise<EventInfo> {
  return apiFetch<EventInfo>(path(calendarId, eventId), { signal });
}

export function saveEventMeta(
  calendarId: string,
  eventId: string,
  input: EventMetaInput,
): Promise<EventInfo> {
  return apiFetch<EventInfo>(`${path(calendarId, eventId)}/meta`, { method: 'PUT', body: input });
}

export function clearEventMeta(
  calendarId: string,
  eventId: string,
  scope: EventMetaScope,
): Promise<EventInfo> {
  return apiFetch<EventInfo>(`${path(calendarId, eventId)}/meta?scope=${scope}`, {
    method: 'DELETE',
  });
}

/** Cuando ocurre el evento, en texto (Europe/Madrid). */
export function formatWhen(e: EventInfo): string {
  if (e.allDay) {
    if (!e.startDate) return '';
    const last =
      e.endDate && e.endDate > e.startDate ? addDaysToDateStr(e.endDate, -1) : e.startDate;
    if (last === e.startDate) return `${formatDayLong(e.startDate)} · Todo el día`;
    return `Del ${formatDayLong(e.startDate)} al ${formatDayLong(last)} · Todo el día`;
  }
  if (!e.startAt) return '';
  const start = new Date(e.startAt);
  if (Number.isNaN(start.getTime())) return '';
  const startDay = formatDateInTz(start);
  const startTime = timeInMadrid(e.startAt);
  if (!e.endAt) return `${formatDayLong(startDay)} · ${startTime}`;
  const end = new Date(e.endAt);
  if (Number.isNaN(end.getTime())) return `${formatDayLong(startDay)} · ${startTime}`;
  const endTime = timeInMadrid(e.endAt);
  const lastDay =
    end.getTime() > start.getTime() ? formatDateInTz(new Date(end.getTime() - 1)) : startDay;
  if (lastDay <= startDay) return `${formatDayLong(startDay)} · ${startTime} - ${endTime}`;
  return `${formatDayLong(startDay)} ${startTime} - ${formatDayLong(formatDateInTz(end))} ${endTime}`;
}

/** Valores editables del formulario (el estado de "heredar" va aparte, por campo). */
export interface MetaForm {
  notes: string;
  remind: boolean;
  days: number;
  /** null = sin color propio. */
  color: string | null;
}

export type MetaField = 'notes' | 'remind' | 'days' | 'color';

/** Valores iniciales: lo resuelto, salvo el color, que es el color PROPIO (no el efectivo). */
export function initialForm(e: EventInfo): MetaForm {
  const own = e.metaScopes?.instance?.color ?? e.metaScopes?.series?.color ?? null;
  return {
    notes: e.notes ?? '',
    remind: e.remind === true,
    days: e.remindDaysBefore || EVENT_META_LIMITS.remindDaysDefault,
    color: isHexColor(own) ? own : null,
  };
}

/**
 * Formulario de un ambito. 'instance' = lo resuelto (instancia > serie > defecto). 'series' = SOLO
 * los valores guardados en la serie (o vacios/por defecto si no hay).
 */
export function formForScope(e: EventInfo, scope: EventMetaScope): MetaForm {
  if (scope === 'instance') return initialForm(e);
  const s = e.metaScopes?.series ?? null;
  return {
    notes: s?.notes ?? '',
    remind: s?.remind === true,
    days: s?.remindDaysBefore || EVENT_META_LIMITS.remindDaysDefault,
    color: isHexColor(s?.color) ? s!.color : null,
  };
}

/** Campos que la instancia tiene definidos y que tapan los de la serie. */
export function shadowedFields(e: EventInfo): MetaField[] {
  const i = e.metaScopes?.instance;
  if (!i) return [];
  const out: MetaField[] = [];
  if (i.notes !== null) out.push('notes');
  if (i.remind !== null) out.push('remind');
  if (i.remindDaysBefore !== null) out.push('days');
  if (i.color !== null) out.push('color');
  return out;
}

const KEY: Record<MetaField, keyof EventMetaValues> = {
  notes: 'notes',
  remind: 'remind',
  days: 'remindDaysBefore',
  color: 'color',
};

/**
 * Cuerpo del PUT: SOLO campos cambiados. `inherit[campo]` -> null (vuelve a heredar; no se envia si
 * el ambito ya no lo tiene definido). Un texto vacio solo se envia si el usuario lo dejo vacio sin
 * pedir heredar (nota vacia explicita). Devuelve null si no hay nada que enviar.
 */
export function buildMetaPatch(
  scope: EventMetaScope,
  initial: MetaForm,
  form: MetaForm,
  inherit: Partial<Record<MetaField, boolean>>,
  stored: EventMetaValues | null | undefined,
): EventMetaInput | null {
  const body: EventMetaInput = { scope };
  let changed = false;
  const set = (field: MetaField, value: string | boolean | number | null) => {
    changed = true;
    if (field === 'notes') body.notes = value as string | null;
    else if (field === 'remind') body.remind = value as boolean | null;
    else if (field === 'days') body.remind_days_before = value as number | null;
    else body.color = value as string | null;
  };
  for (const field of ['notes', 'remind', 'days', 'color'] as const) {
    if (inherit[field]) {
      // Si el ambito ya tiene null (o no hay fila) no hay nada que quitar.
      if (stored && stored[KEY[field]] !== null) set(field, null);
    } else if (form[field] !== initial[field]) {
      set(field, form[field]);
    }
  }
  return changed ? body : null;
}
