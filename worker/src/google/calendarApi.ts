/**
 * UNICO punto de salida hacia Calendar API v3 (ningun otro archivo de worker/src contiene la URL
 * base; lo verifica un test estatico). Solo se permiten combinaciones metodo+ruta de la
 * allowlist; cualquier otra lanza antes de hacer red. Hoy SOLO GET (calendarList y events.list);
 * T2.10 anadira aqui las escrituras.
 */
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3/';
const FETCH_TIMEOUT_MS = 10_000;

export type GoogleMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Allowlist explicita `METODO ruta` (ruta relativa a /calendar/v3/, sin barra inicial). */
export const ALLOWED_REQUESTS: ReadonlySet<string> = new Set(['GET users/me/calendarList']);

/**
 * Segmento `{calendarId}` ya codificado con encodeURIComponent (sin `/`, `?`, `#` en claro) y
 * nunca `.`/`..` ni sus formas `%2e` (la resolucion de URL los trataria como directorios).
 */
const CALENDAR_ID_SEGMENT = /^(?:[A-Za-z0-9\-_.!~*'()]|%[0-9A-F]{2})+$/;
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Rutas con parametro, por metodo. SOLO lectura: `events.list` (sync T2.4). Las escrituras
 * (POST/PATCH/DELETE de eventos) llegan en T2.10 con su propio test.
 */
const ALLOWED_PATTERNS: readonly { method: GoogleMethod; re: RegExp }[] = [
  { method: 'GET', re: /^calendars\/([^/]+)\/events$/ },
];

export function isAllowedRequest(method: GoogleMethod, path: string): boolean {
  if (ALLOWED_REQUESTS.has(`${method} ${path}`)) return true;
  return ALLOWED_PATTERNS.some((p) => {
    if (p.method !== method) return false;
    const m = p.re.exec(path);
    return !!m && CALENDAR_ID_SEGMENT.test(m[1]!) && !DOT_SEGMENT.test(m[1]!);
  });
}

/** Ruta de `events.list` para un calendarId (codificado). */
export function eventsPath(calendarId: string): string {
  return `calendars/${encodeURIComponent(calendarId)}/events`;
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

/** Peticion a Calendar API. Lanza Error si metodo+ruta no esta en la allowlist; GoogleApiError si falla. */
export async function googleRequest(
  method: GoogleMethod,
  path: string,
  opts: { token: string; query?: Record<string, string>; body?: unknown },
): Promise<unknown> {
  if (!isAllowedRequest(method, path)) {
    // Sin la ruta en el mensaje: puede contener un calendarId (email).
    throw new Error(`google_request_not_allowed: ${method}`);
  }
  const url = new URL(path, CALENDAR_API_BASE);
  // Defensa extra: la URL resuelta debe seguir bajo /calendar/v3/.
  if (!url.href.startsWith(CALENDAR_API_BASE)) {
    throw new Error(`google_request_not_allowed: ${method}`);
  }
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleApiError(0);
  }
  if (!res.ok) {
    console.warn('google_calendar_api', 'http_error', res.status);
    throw new GoogleApiError(res.status, await errorReason(res));
  }
  try {
    return await res.json();
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
  return googleRequest('GET', eventsPath(calendarId), { token, query });
}
