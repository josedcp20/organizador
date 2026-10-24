import { addDaysToDateStr, AGENDA_WRITE_LIMITS } from '@organizador/shared';
import type { DisplayTime, DisplayValues } from '../db/eventWrites';
import { LOCAL_ID_RE, type EventFields, type EventTime } from '../google/eventPayload';

/**
 * Validacion de los cuerpos de `POST /api/agenda` y `PATCH /api/agenda/:c/:e` (T3.7). Produce
 * `EventFields` (lo UNICO que llega a toGooglePayload) y los valores optimistas para D1. Lista
 * blanca de claves: cualquier otra (notas, color, avisos...) se rechaza con 400, nunca se ignora en
 * silencio, para que la UI no crea que algo privado se guardo por esta via.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

const CREATE_KEYS = new Set([
  'client_id',
  'calendarId',
  'summary',
  'location',
  'description',
  'allDay',
  'start',
  'end',
]);
const PATCH_KEYS = new Set([
  'summary',
  'location',
  'description',
  'allDay',
  'start',
  'end',
  'confirm_external',
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** ISO con desfase explicito (Z o +hh:mm). */
const ISO_OFFSET_RE =
  /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Hora local sin desfase: se interpreta en la zona de la app (Europe/Madrid). */
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const MIN_YEAR = 1970;
const MAX_YEAR = 2100;
const MAX_CALENDAR_ID = 1024;

function isRealDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const year = Number(s.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  return addDaysToDateStr(s, 0) === s;
}

/** Milisegundos que `tz` va por delante de UTC en `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/** Hora de pared en `tz` -> instante UTC (ms). En el salto de primavera cae tras el salto. */
export function wallTimeToUtcMs(wallAsUtcMs: number, tz: string): number {
  const first = wallAsUtcMs - tzOffsetMs(wallAsUtcMs, tz);
  return wallAsUtcMs - tzOffsetMs(first, tz);
}

interface InstantDetail {
  iso: string;
  /** Hora local inexistente (salto de primavera): se movio hacia delante el tamano del salto. */
  shifted: boolean;
}

/**
 * Instante con hora -> ISO UTC (`...000Z`), o null si no es valido.
 *
 * Hora local sin desfase en los cambios de hora de `tz` (comportamiento fijado por tests):
 * - Inexistente (primavera, p. ej. 02:30 el 2026-03-29 en Madrid): se mueve hacia delante el tamano
 *   del salto (03:30 CEST = 01:30Z), como hacen Google Calendar y los relojes de pared.
 * - Ambigua (otono, p. ej. 02:30 el 2026-10-25, que ocurre dos veces): se toma la SEGUNDA
 *   ocurrencia, ya en horario de invierno (02:30 CET = 01:30Z). Para la primera hay que enviar el
 *   desfase explicito (`2026-10-25T02:30+02:00`).
 */
function parseInstantDetail(v: unknown, tz: string): InstantDetail | null {
  if (typeof v !== 'string') return null;
  const off = ISO_OFFSET_RE.exec(v);
  if (off) {
    if (!isRealDate(off[1])) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), shifted: false } : null;
  }
  const loc = LOCAL_RE.exec(v);
  if (!loc) return null;
  if (!isRealDate(`${loc[1]}-${loc[2]}-${loc[3]}`)) return null;
  const [h, mi, s] = [Number(loc[4]), Number(loc[5]), Number(loc[6] ?? '0')];
  if (h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(Number(loc[1]), Number(loc[2]) - 1, Number(loc[3]), h, mi, s);
  const utc = wallTimeToUtcMs(wall, tz);
  // Si al volver a hora local no sale la misma hora de pared, la hora no existia en `tz`.
  const shifted = utc + tzOffsetMs(utc, tz) !== wall;
  return { iso: new Date(utc).toISOString(), shifted };
}

export function parseInstant(v: unknown, tz: string): string | null {
  return parseInstantDetail(v, tz)?.iso ?? null;
}

export interface ParsedTime {
  start: EventTime;
  end: EventTime;
  display: DisplayTime;
  /** Clave de inicio para la regla de congelado: fecha (dia completo) o ISO UTC. */
  startKey: string;
}

function parseTimes(allDay: unknown, start: unknown, end: unknown, tz: string): Parsed<ParsedTime> {
  if (typeof allDay !== 'boolean') return fail('allDay must be boolean');
  if (allDay) {
    if (!isRealDate(start) || !isRealDate(end)) {
      return fail('start and end must be dates (YYYY-MM-DD) for all-day events');
    }
    if (end <= start) return fail('end must be after start (end date is exclusive)');
    return {
      ok: true,
      value: {
        start: { allDay: true, date: start },
        end: { allDay: true, date: end },
        display: { allDay: true, startDate: start, endDate: end },
        startKey: start,
      },
    };
  }
  const sd = parseInstantDetail(start, tz);
  const ed = parseInstantDetail(end, tz);
  if (!sd || !ed) {
    return fail('start and end must be ISO date-times (with offset, or local Europe/Madrid time)');
  }
  const [s, e] = [sd.iso, ed.iso];
  if (e < s) {
    const skipped = [sd.shifted ? start : null, ed.shifted ? end : null].filter(Boolean);
    if (skipped.length) {
      return fail(
        `end must not be before start: local time ${skipped.join(' and ')} does not exist in ` +
          `${tz} (clocks go forward at the DST change) and was moved forward past the gap`,
      );
    }
    return fail('end must not be before start');
  }
  return {
    ok: true,
    value: {
      start: { allDay: false, dateTime: s },
      end: { allDay: false, dateTime: e },
      display: { allDay: false, startAt: s, endAt: e },
      startKey: s,
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseSummary(v: unknown): Parsed<string> {
  if (typeof v !== 'string') return fail('summary must be a string');
  const t = v.trim();
  if (!t) return fail('summary must not be empty');
  if (t.length > AGENDA_WRITE_LIMITS.summaryMax) {
    return fail(`summary must be at most ${AGENDA_WRITE_LIMITS.summaryMax} characters`);
  }
  return { ok: true, value: t };
}

/** location/description: string o null; '' o null = vacio (null). */
function parseOptionalText(
  v: unknown,
  name: 'location' | 'description',
  max: number,
): Parsed<string | null> {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== 'string') return fail(`${name} must be a string or null`);
  const t = name === 'location' ? v.trim() : v;
  if (t.length > max) return fail(`${name} must be at most ${max} characters`);
  return { ok: true, value: t.trim() === '' ? null : t };
}

export interface CreateInput {
  localId: string;
  calendarId: string;
  fields: EventFields;
  display: DisplayValues & { time: DisplayTime };
  startKey: string;
  allDay: boolean;
}

export function parseCreateBody(raw: unknown, tz: string): Parsed<CreateInput> {
  if (!isPlainObject(raw)) return fail('Body must be an object');
  const extra = Object.keys(raw).filter((k) => !CREATE_KEYS.has(k));
  if (extra.length) return fail(`Unknown fields: ${extra.join(', ')}`);
  const localId = raw.client_id;
  if (typeof localId !== 'string' || !LOCAL_ID_RE.test(localId)) {
    return fail(`client_id must match [A-Za-z0-9-]{1,${AGENDA_WRITE_LIMITS.clientIdMax}}`);
  }
  const calendarId = raw.calendarId;
  if (typeof calendarId !== 'string' || !calendarId || calendarId.length > MAX_CALENDAR_ID) {
    return fail('calendarId is required');
  }
  const summary = parseSummary(raw.summary);
  if (!summary.ok) return summary;
  const location = parseOptionalText(
    raw.location ?? null,
    'location',
    AGENDA_WRITE_LIMITS.locationMax,
  );
  if (!location.ok) return location;
  const description = parseOptionalText(
    raw.description ?? null,
    'description',
    AGENDA_WRITE_LIMITS.descriptionMax,
  );
  if (!description.ok) return description;
  const t = parseTimes(raw.allDay, raw.start, raw.end, tz);
  if (!t.ok) return t;

  const fields: EventFields = { summary: summary.value, start: t.value.start, end: t.value.end };
  if (location.value !== null) fields.location = location.value;
  if (description.value !== null) fields.description = description.value;
  return {
    ok: true,
    value: {
      localId,
      calendarId,
      fields,
      display: {
        summary: summary.value,
        location: location.value,
        description: description.value,
        time: t.value.display,
      },
      startKey: t.value.startKey,
      allDay: t.value.display.allDay,
    },
  };
}

export interface PatchInput {
  fields: EventFields;
  display: DisplayValues;
  confirmExternal: boolean;
  /** Solo si cambian las fechas. */
  time: { startKey: string; allDay: boolean } | null;
}

export function parsePatchBody(raw: unknown, tz: string): Parsed<PatchInput> {
  if (!isPlainObject(raw)) return fail('Body must be an object');
  const extra = Object.keys(raw).filter((k) => !PATCH_KEYS.has(k));
  if (extra.length) return fail(`Unknown fields: ${extra.join(', ')}`);
  if ('confirm_external' in raw && typeof raw.confirm_external !== 'boolean') {
    return fail('confirm_external must be boolean');
  }
  const fields: EventFields = {};
  const display: DisplayValues = {};
  if ('summary' in raw) {
    const s = parseSummary(raw.summary);
    if (!s.ok) return s;
    fields.summary = s.value;
    display.summary = s.value;
  }
  for (const [name, max] of [
    ['location', AGENDA_WRITE_LIMITS.locationMax],
    ['description', AGENDA_WRITE_LIMITS.descriptionMax],
  ] as const) {
    if (!(name in raw)) continue;
    const r = parseOptionalText(raw[name], name, max);
    if (!r.ok) return r;
    fields[name] = r.value; // null = vaciar en Google
    display[name] = r.value;
  }
  let time: PatchInput['time'] = null;
  const timeKeys = ['allDay', 'start', 'end'].filter((k) => k in raw);
  if (timeKeys.length > 0) {
    if (timeKeys.length !== 3) return fail('allDay, start and end must be sent together');
    const t = parseTimes(raw.allDay, raw.start, raw.end, tz);
    if (!t.ok) return t;
    fields.start = t.value.start;
    fields.end = t.value.end;
    display.time = t.value.display;
    time = { startKey: t.value.startKey, allDay: t.value.display.allDay };
  }
  if (Object.keys(fields).length === 0) return fail('Nothing to change');
  return {
    ok: true,
    value: { fields, display, confirmExternal: raw.confirm_external === true, time },
  };
}
