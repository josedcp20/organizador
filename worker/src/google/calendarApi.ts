import { isGooglePayload, payloadMode, type GooglePayload } from './eventPayload';

/**
 * UNICO punto de salida hacia Calendar API v3 (ningun otro archivo de worker/src contiene la URL
 * base; lo verifica un test estatico). Solo se permiten combinaciones metodo+ruta de la
 * allowlist; cualquier otra lanza antes de hacer red.
 *
 * Lectura: GET de la lista de calendarios, events.list y events.get de un evento.
 * Escritura (T2.10, D10): SOLO insert/patch/delete de UN evento. Siempre `sendUpdates=none`
 * (nunca se notifica a invitados). Patch/delete exigen `If-Match` con el etag del BODY del evento
 * (el header ETag de Google no coincide con el del body: spike T2.1). El cuerpo de POST/PATCH debe
 * salir de `toGooglePayload` (lista blanca de campos): cualquier otro objeto se rechaza.
 */
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3/';
const FETCH_TIMEOUT_MS = 10_000;

export type GoogleMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Allowlist explicita `METODO ruta` (ruta relativa a /calendar/v3/, sin barra inicial). */
export const ALLOWED_REQUESTS: ReadonlySet<string> = new Set(['GET users/me/calendarList']);

/**
 * Segmento `{calendarId}`/`{eventId}` ya codificado con encodeURIComponent (sin `/`, `?`, `#` en
 * claro) y nunca `.`/`..` ni sus formas `%2e` (la resolucion de URL los trataria como directorios).
 */
const SEGMENT = /^(?:[A-Za-z0-9\-_.!~*'()]|%[0-9A-F]{2})+$/;
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/** Rutas con parametros, por metodo. Cada grupo capturado es un segmento validado con SEGMENT. */
const ALLOWED_PATTERNS: readonly { method: GoogleMethod; re: RegExp }[] = [
  { method: 'GET', re: /^calendars\/([^/]+)\/events$/ }, // events.list (sync T2.4)
  { method: 'GET', re: /^calendars\/([^/]+)\/events\/([^/]+)$/ }, // events.get
  { method: 'POST', re: /^calendars\/([^/]+)\/events$/ }, // events.insert
  { method: 'PATCH', re: /^calendars\/([^/]+)\/events\/([^/]+)$/ }, // events.patch
  { method: 'DELETE', re: /^calendars\/([^/]+)\/events\/([^/]+)$/ }, // events.delete
];

/**
 * Segmentos fijos que NUNCA son un eventId valido aunque encajen en el patron: sub-recursos de
 * events (alta por texto libre, importacion, watch) que no deben poder invocarse.
 */
const RESERVED_EVENT_SEGMENTS = new Set(['quickadd', 'import', 'watch', 'instances', 'move']);

const validSegment = (s: string) => SEGMENT.test(s) && !DOT_SEGMENT.test(s);

/** eventId: ids base32hex propios, ids de Google e instancias recurrentes (`<id>_20261010T...Z`). */
const EVENT_ID_SEGMENT = /^[A-Za-z0-9_-]+$/;

export function isAllowedRequest(method: GoogleMethod, path: string): boolean {
  if (ALLOWED_REQUESTS.has(`${method} ${path}`)) return true;
  return ALLOWED_PATTERNS.some((p) => {
    if (p.method !== method) return false;
    const m = p.re.exec(path);
    if (!m) return false;
    const segs = m.slice(1) as string[];
    if (!segs.every(validSegment)) return false;
    const eventId = segs[1];
    if (eventId === undefined) return true;
    return EVENT_ID_SEGMENT.test(eventId) && !RESERVED_EVENT_SEGMENTS.has(eventId.toLowerCase());
  });
}

/** Ruta de events.list / events.insert para un calendarId (codificado). */
export function eventsPath(calendarId: string): string {
  return `calendars/${encodeURIComponent(calendarId)}/events`;
}

/** Ruta de un evento concreto (events.get/patch/delete). */
export function eventPath(calendarId: string, eventId: string): string {
  return `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`;
}

export class GoogleApiError extends Error {
  readonly status: number;
  /** `error.errors[0].reason` de Google (p. ej. insufficientPermissions), si lo hay. */
  readonly reason: string | null;
  constructor(status: number, reason: string | null = null) {
    super(`google_api_${status}`);
    this.name = 'GoogleApiError';
    this.status = status;
    this.reason = reason;
  }
}

async function errorReason(res: Response): Promise<string | null> {
  try {
    const b = (await res.json()) as { error?: { errors?: { reason?: unknown }[] } };
    const r = b?.error?.errors?.[0]?.reason;
    return typeof r === 'string' ? r : null;
  } catch {
    return null;
  }
}

/** Etag como valor de cabecera: ASCII visible, acotado (evita inyeccion de cabeceras). */
const ETAG_RE = /^[\x21-\x7e]{1,256}$/;

export function isValidEtag(etag: unknown): etag is string {
  return typeof etag === 'string' && ETAG_RE.test(etag);
}

function notAllowed(method: GoogleMethod): Error {
  // Sin la ruta en el mensaje: puede contener un calendarId (email).
  return new Error(`google_request_not_allowed: ${method}`);
}

export interface GoogleRequestOptions {
  token: string;
  /** Solo GET. En escrituras el unico parametro es `sendUpdates=none`, que se fija aqui. */
  query?: Record<string, string>;
  /** Solo POST/PATCH, y solo un cuerpo creado por `toGooglePayload`. */
  body?: GooglePayload;
  /** Obligatorio en PATCH/DELETE: etag del body del evento. */
  ifMatch?: string;
}

/**
 * Peticion a Calendar API. Lanza Error si metodo+ruta no esta en la allowlist o las opciones no
 * encajan con el metodo; GoogleApiError si Google falla. Devuelve el JSON, o null si no hay cuerpo
 * (204 del delete).
 */
export async function googleRequest(
  method: GoogleMethod,
  path: string,
  opts: GoogleRequestOptions,
): Promise<unknown> {
  if (!isAllowedRequest(method, path)) throw notAllowed(method);
  const write = method !== 'GET';
  const hasQuery = !!opts.query && Object.keys(opts.query).length > 0;
  const needsBody = method === 'POST' || method === 'PATCH';
  const needsEtag = method === 'PATCH' || method === 'DELETE';
  if (write && hasQuery) throw notAllowed(method);
  if (needsBody ? !isGooglePayload(opts.body) : opts.body !== undefined) throw notAllowed(method);
  // POST solo admite cuerpos de insert y PATCH solo cuerpos de patch (un patch no lleva id/marca).
  if (needsBody && payloadMode(opts.body) !== (method === 'POST' ? 'insert' : 'patch')) {
    throw notAllowed(method);
  }
  if (needsEtag ? !isValidEtag(opts.ifMatch) : opts.ifMatch !== undefined) {
    throw notAllowed(method);
  }

  const url = new URL(path, CALENDAR_API_BASE);
  // Defensa extra: la URL resuelta debe seguir bajo /calendar/v3/.
  if (!url.href.startsWith(CALENDAR_API_BASE)) throw notAllowed(method);
  if (write) {
    url.searchParams.set('sendUpdates', 'none');
  } else {
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/json',
  };
  if (needsBody) headers['Content-Type'] = 'application/json';
  if (needsEtag) headers['If-Match'] = opts.ifMatch!;
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: needsBody ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw new GoogleApiError(0);
  }
  if (!res.ok) {
    console.warn('google_calendar_api', 'http_error', method, res.status);
    throw new GoogleApiError(res.status, await errorReason(res));
  }
  if (res.status === 204) return null;
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new GoogleApiError(502);
  }
  if (text === '') {
    if (method === 'DELETE') return null;
    throw new GoogleApiError(502);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GoogleApiError(502);
  }
}

/**
 * Una pagina de `events.list` (solo lectura). `query` la arma el motor de sync
 * (singleEvents, showDeleted, maxResults, timeMin/timeMax o syncToken, pageToken).
 */
export async function listEventsPage(
  token: string,
  calendarId: string,
  query: Record<string, string>,
): Promise<unknown> {
  return await googleRequest('GET', eventsPath(calendarId), { token, query });
}

/** events.get de un evento (lectura; se usa tras un 409 duplicate del insert). */
export async function getEventRequest(
  token: string,
  calendarId: string,
  eventId: string,
): Promise<unknown> {
  return await googleRequest('GET', eventPath(calendarId, eventId), { token });
}

/** events.insert (sendUpdates=none). El id propio va en el cuerpo. */
export async function insertEventRequest(
  token: string,
  calendarId: string,
  body: GooglePayload,
): Promise<unknown> {
  return await googleRequest('POST', eventsPath(calendarId), { token, body });
}

/** events.patch con If-Match (sendUpdates=none). */
export async function patchEventRequest(
  token: string,
  calendarId: string,
  eventId: string,
  etag: string,
  body: GooglePayload,
): Promise<unknown> {
  return await googleRequest('PATCH', eventPath(calendarId, eventId), {
    token,
    body,
    ifMatch: etag,
  });
}

/** events.delete con If-Match (sendUpdates=none). */
export async function deleteEventRequest(
  token: string,
  calendarId: string,
  eventId: string,
  etag: string,
): Promise<unknown> {
  return await googleRequest('DELETE', eventPath(calendarId, eventId), { token, ifMatch: etag });
}
