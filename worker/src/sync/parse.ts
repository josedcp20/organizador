/**
 * Normaliza un item de `events.list` (singleEvents=true) a una fila de `events`.
 * Solo campos del evento que existen en Google; NUNCA colorId (el color es propio de la app),
 * asistentes, recordatorios, etc. El `etag` es el del BODY (el header ETag no coincide: spike T2.1).
 */

export interface ParsedEvent {
  id: string;
  status: 'confirmed' | 'tentative';
  recurringEventId: string | null;
  summary: string | null;
  location: string | null;
  description: string | null;
  allDay: boolean;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
  htmlLink: string | null;
  updated: string | null;
  etag: string | null;
  originalStart: string | null;
  /** extendedProperties.private.organizadorId (eventos creados desde la app, T3.7). */
  organizadorId: string | null;
}

export type ParsedItem =
  { kind: 'event'; event: ParsedEvent } | { kind: 'cancelled'; id: string } | { kind: 'invalid' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ID_LEN = 1024;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** RFC3339 -> ISO UTC normalizado (comparable como texto). */
export function toUtcIso(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

type When = { allDay: true; date: string } | { allDay: false; at: string };

function parseWhen(v: unknown): When | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Record<string, unknown>;
  if (typeof w.date === 'string' && DATE_RE.test(w.date)) return { allDay: true, date: w.date };
  // dateTime de Google siempre lleva desfase; `timeZone` solo importa para recurrencias.
  const at = toUtcIso(w.dateTime);
  return at ? { allDay: false, at } : null;
}

function whenKey(w: When | null): string | null {
  if (!w) return null;
  return w.allDay ? w.date : w.at;
}

export function parseGoogleEvent(raw: unknown): ParsedItem {
  if (!raw || typeof raw !== 'object') return { kind: 'invalid' };
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id || id.length > MAX_ID_LEN) return { kind: 'invalid' };
  if (r.status === 'cancelled') return { kind: 'cancelled', id };

  const start = parseWhen(r.start);
  let end = parseWhen(r.end);
  if (!start) return { kind: 'invalid' };
  // Fin ausente o de otro tipo (no deberia pasar): evento de duracion nula.
  if (!end || end.allDay !== start.allDay) end = start;

  const priv = (r.extendedProperties as { private?: Record<string, unknown> } | undefined)?.private;
  const orgId = str(priv?.organizadorId);

  return {
    kind: 'event',
    event: {
      id,
      status: r.status === 'tentative' ? 'tentative' : 'confirmed',
      recurringEventId: str(r.recurringEventId),
      summary: str(r.summary),
      location: str(r.location),
      description: str(r.description),
      allDay: start.allDay,
      startAt: start.allDay ? null : start.at,
      endAt: end.allDay ? null : end.at,
      startDate: start.allDay ? start.date : null,
      endDate: end.allDay ? end.date : null,
      htmlLink: str(r.htmlLink),
      updated: toUtcIso(r.updated),
      etag: str(r.etag),
      originalStart: whenKey(parseWhen(r.originalStartTime)),
      organizadorId: orgId && orgId.length <= 64 ? orgId : null,
    },
  };
}
