import { clearToken, getToken, isSessionToken } from './auth';
import { navigateTo } from '../router';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  /** Cuerpo JSON de la respuesta de error (p. ej. `current` del 409 conflict). */
  readonly body?: unknown;

  constructor(status: number, code: string, message: string, retryAfter?: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

/**
 * Base URL del Worker: SOLO de VITE_API_BASE. Fail-closed: sin valor, o sin https
 * (salvo localhost/127.0.0.1), lanza y no se hace ninguna peticion. Sin fallback.
 */
export function getApiBase(): string {
  const raw = import.meta.env.VITE_API_BASE;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new ApiError(0, 'config', 'VITE_API_BASE no esta configurada.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(0, 'config', 'VITE_API_BASE no es una URL valida.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  if (!ok) throw new ApiError(0, 'config', 'VITE_API_BASE debe usar https.');
  return url.origin;
}

function assertEndpoint(endpoint: string): void {
  const bad =
    typeof endpoint !== 'string' ||
    !endpoint.startsWith('/api/') ||
    endpoint.startsWith('//') ||
    endpoint.includes('\\') ||
    endpoint.includes('..') ||
    /%2e|%2f|%5c/i.test(endpoint) ||
    [...endpoint].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f);
  if (bad) throw new ApiError(0, 'bad_endpoint', 'Endpoint no permitido.');
}

/** Borra de Cache Storage las entradas cuyo path empiece por /api/. */
export async function clearApiCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        let path = '';
        try {
          path = new URL(req.url).pathname;
        } catch {
          continue;
        }
        if (path.startsWith('/api/')) await cache.delete(req);
      }
    }
  } catch {
    // best effort
  }
}

/** Endpoints sin Authorization: no exigen token ni disparan logout ante 401. */
const PUBLIC_ENDPOINTS = new Set([
  '/api/health',
  '/api/passkeys/login/options',
  '/api/passkeys/login',
]);

function isPublic(endpoint: string): boolean {
  return PUBLIC_ENDPOINTS.has(endpoint.split('?')[0]);
}

/** Cierra sesion: borra token y caches de API y vuelve a login. */
export async function logout(): Promise<void> {
  const token = getToken();
  // Best effort, sin bloquear: revoca la sesion Face ID en el servidor.
  if (token && isSessionToken(token)) {
    apiFetch('/api/session/logout', { method: 'POST', token }).catch(() => undefined);
  }
  clearToken();
  await clearApiCaches();
  navigateTo('login');
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  /** Token explicito (login): no dispara logout ante 401. */
  token?: string;
  signal?: AbortSignal;
}

export async function apiFetch<T = unknown>(endpoint: string, opts: ApiOptions = {}): Promise<T> {
  assertEndpoint(endpoint);
  const base = getApiBase();
  const pub = isPublic(endpoint);
  const explicit = opts.token !== undefined || pub;
  const token = explicit ? opts.token : getToken();

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!pub) {
    if (!token) throw new ApiError(0, 'no_token', 'No hay sesion iniciada.');
    headers.Authorization = `Bearer ${token}`;
  }
  const init: NonNullable<Parameters<typeof fetch>[1]> = {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'omit',
    signal: opts.signal,
  };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(base + endpoint, init);
  } catch {
    throw new ApiError(0, 'network', 'No se pudo conectar con el servidor.');
  }

  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  let code = 'error';
  let message = `Error ${res.status}`;
  let body: unknown;
  try {
    const data = (await res.json()) as { error?: { code?: string; message?: string } };
    body = data;
    if (data?.error?.code) code = data.error.code;
    if (data?.error?.message) message = data.error.message;
  } catch {
    // cuerpo no JSON
  }

  if (res.status === 401) {
    if (!explicit) await logout();
    throw new ApiError(401, code, message, undefined, body);
  }
  if (res.status === 429) {
    const ra = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
    throw new ApiError(429, code, message, Number.isFinite(ra) && ra > 0 ? ra : undefined, body);
  }
  throw new ApiError(res.status, code, message, undefined, body);
}
