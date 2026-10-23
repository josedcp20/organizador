/**
 * UNICO constructor de cuerpos de escritura hacia Google Calendar (insert/patch de eventos).
 *
 * Lista blanca EXPLICITA: solo se leen, por nombre, los campos de evento que existen en Google
 * (`summary`, `location`, `description`, `start`, `end`) y, en el insert, `id` +
 * `extendedProperties.private.organizadorId` (marca de la app). Cualquier otra clave del objeto de
 * entrada se ignora aunque venga en tiempo de ejecucion: notas privadas, detalles, flag "avisar",
 * dias de antelacion, colores (propios o `colorId`), notas rapidas, asistentes, recordatorios,
 * recurrencia... NUNCA salen hacia Google (restriccion dura 2, guardarrail T2.9).
 *
 * `description` es la descripcion PUBLICA del evento en Google (la UI la etiqueta "se guarda en
 * Google"); las notas privadas viven en `event_meta` y no pasan por aqui.
 *
 * Los cuerpos producidos se congelan y se registran en un WeakMap (con su modo insert/patch):
 * `calendarApi.googleRequest` rechaza cualquier POST/PATCH cuyo cuerpo no salga de aqui, y un
 * PATCH con un cuerpo de insert (id/extendedProperties) o un POST con uno de patch.
 */
import { DEFAULT_TZ } from '../sync/window';

/** Inicio/fin de un evento: dia completo (`date`, fin EXCLUSIVO) o con hora (instante ISO). */
export type EventTime = { allDay: true; date: string } | { allDay: false; dateTime: string };

/**
 * Campos de evento que la app puede escribir en Google. En patch, ausente = no se toca;
 * `null` o '' en summary/location/description = vaciar el campo en Google.
 */
export interface EventFields {
  summary?: string | null;
  location?: string | null;
  description?: string | null;
  start?: EventTime;
  end?: EventTime;
}

type GoogleTime = { date: string } | { dateTime: string; timeZone: string };

export interface GoogleEventBody {
  id?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  extendedProperties?: { private: { organizadorId: string } };
}

declare const sanitized: unique symbol;
/** Cuerpo ya filtrado por `toGooglePayload` (marca de tipo; ademas se verifica en tiempo de ejecucion). */
export type GooglePayload = Readonly<GoogleEventBody> & { readonly [sanitized]: true };

/** Claves que puede llevar un cuerpo de escritura (lo comprueba tambien el test T2.9). */
export const PAYLOAD_KEYS: readonly string[] = Object.freeze([
  'id',
  'summary',
  'location',
  'description',
  'start',
  'end',
  'extendedProperties',
]);

export const MAX_SUMMARY = 1024;
export const MAX_LOCATION = 1024;
export const MAX_DESCRIPTION = 8192;

/** Id de evento propio: base32hex (0-9, a-v), 5..1024 (doc de Google; validado en el spike). */
export const EVENT_ID_RE = /^[0-9a-v]{5,1024}$/;
/** organizadorId (local_id): uuid u otro id corto alfanumerico (parse.ts acepta hasta 64). */
export const LOCAL_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class PayloadError extends Error {
  constructor(readonly field: string) {
    super(`invalid_payload: ${field}`);
    this.name = 'PayloadError';
  }
}

const produced = new WeakMap<object, 'insert' | 'patch'>();

/** true solo para cuerpos creados por `toGooglePayload` (y por tanto filtrados). */
export function isGooglePayload(body: unknown): body is GooglePayload {
  return typeof body === 'object' && body !== null && produced.has(body);
}

/** Modo con el que se creo el cuerpo (insert o patch); undefined si no sale de `toGooglePayload`. */
export function payloadMode(body: unknown): 'insert' | 'patch' | undefined {
  return typeof body === 'object' && body !== null ? produced.get(body) : undefined;
}

function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function readTime(
  v: unknown,
  field: string,
  tz: string,
): { g: GoogleTime; key: string; allDay: boolean } {
  if (!v || typeof v !== 'object') throw new PayloadError(field);
  const t = v as Record<string, unknown>;
  if (t.allDay === true) {
    if (!validDate(t.date)) throw new PayloadError(field);
    return { g: { date: t.date }, key: t.date, allDay: true };
  }
  if (t.allDay === false && typeof t.dateTime === 'string') {
    const ms = Date.parse(t.dateTime);
    if (!Number.isFinite(ms)) throw new PayloadError(field);
    const iso = new Date(ms).toISOString();
    return { g: { dateTime: iso, timeZone: tz }, key: iso, allDay: false };
  }
  throw new PayloadError(field);
}

function readText(
  fields: Record<string, unknown>,
  name: 'summary' | 'location' | 'description',
  max: number,
  mode: 'insert' | 'patch',
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(fields, name)) return undefined;
  const v = fields[name];
  if (v === undefined) return undefined;
  if (v === null) return mode === 'patch' ? '' : undefined;
  if (typeof v !== 'string') throw new PayloadError(name);
  if (v.length > max) throw new PayloadError(name);
  if (v === '' && mode === 'insert') return undefined;
  return v;
}

function deepFreeze<T extends object>(o: T): T {
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') deepFreeze(v as object);
  }
  return Object.freeze(o);
}

export interface PayloadOptions {
  /** Solo insert: id de Google (base32hex) y organizadorId (marca de la app). */
  id?: string;
  organizadorId?: string;
  /** Zona para eventos con hora (por defecto Europe/Madrid). */
  timeZone?: string;
}

/**
 * Construye el cuerpo de un insert (`mode='insert'`: id + marca + start/end obligatorios) o de un
 * patch (`mode='patch'`: solo los campos presentes; start y end van juntos). Lanza PayloadError si
 * algun campo es invalido. El resultado esta congelado y registrado.
 */
export function toGooglePayload(
  input: EventFields,
  mode: 'insert' | 'patch',
  opts: PayloadOptions = {},
): GooglePayload {
  if (!input || typeof input !== 'object') throw new PayloadError('fields');
  const fields = input as Record<string, unknown>;
  const tz = opts.timeZone || DEFAULT_TZ;
  const body: GoogleEventBody = {};

  if (mode === 'insert') {
    if (typeof opts.id !== 'string' || !EVENT_ID_RE.test(opts.id)) throw new PayloadError('id');
    if (typeof opts.organizadorId !== 'string' || !LOCAL_ID_RE.test(opts.organizadorId)) {
      throw new PayloadError('organizadorId');
    }
    body.id = opts.id;
  } else if (opts.id !== undefined || opts.organizadorId !== undefined) {
    // El patch nunca cambia id ni marca (no se etiqueta como "de la app" un evento de Google).
    throw new PayloadError('id');
  }

  const summary = readText(fields, 'summary', MAX_SUMMARY, mode);
  const location = readText(fields, 'location', MAX_LOCATION, mode);
  const description = readText(fields, 'description', MAX_DESCRIPTION, mode);
  if (summary !== undefined) body.summary = summary;
  if (location !== undefined) body.location = location;
  if (description !== undefined) body.description = description;

  const hasStart = fields.start !== undefined;
  const hasEnd = fields.end !== undefined;
  if (mode === 'insert' && (!hasStart || !hasEnd)) throw new PayloadError('start');
  if (hasStart !== hasEnd) throw new PayloadError(hasStart ? 'end' : 'start');
  if (hasStart) {
    const s = readTime(fields.start, 'start', tz);
    const e = readTime(fields.end, 'end', tz);
    if (s.allDay !== e.allDay) throw new PayloadError('end');
    // Dia completo: end.date exclusivo (> start). Con hora: fin >= inicio.
    if (s.allDay ? e.key <= s.key : e.key < s.key) throw new PayloadError('end');
    body.start = s.g;
    body.end = e.g;
  }

  if (mode === 'insert') {
    body.extendedProperties = { private: { organizadorId: opts.organizadorId! } };
  } else if (Object.keys(body).length === 0) {
    throw new PayloadError('fields'); // patch vacio: nada que enviar
  }

  const frozen = deepFreeze(body);
  produced.set(frozen, mode);
  return frozen as GooglePayload;
}

/** Alfabeto base32hex (RFC 4648 seccion 7) en minusculas: el que admite Google para `id`. */
const B32HEX = '0123456789abcdefghijklmnopqrstuv';

export function toBase32Hex(bytes: Uint8Array): string {
  let out = '';
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = ((buf << 8) | b) & 0xffff; // nunca quedan mas de 12 bits pendientes
    bits += 8;
    while (bits >= 5) {
      out += B32HEX[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32HEX[(buf << (5 - bits)) & 31];
  return out;
}

/**
 * Id de Google (32 chars base32hex) DETERMINISTA a partir del organizadorId: reintentar el insert
 * del mismo evento usa el mismo id (Google responde 409 duplicate y no se duplica) y el eco del
 * sync cae en la misma fila de D1.
 */
export async function eventIdFor(organizadorId: string): Promise<string> {
  if (!LOCAL_ID_RE.test(organizadorId)) throw new PayloadError('organizadorId');
  const data = new TextEncoder().encode(`organizador/event-id/v1:${organizadorId}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase32Hex(digest.slice(0, 20));
}
