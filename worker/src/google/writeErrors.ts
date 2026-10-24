import { GoogleApiError } from './calendarApi';
import { PayloadError } from './eventPayload';

/**
 * Clasificacion de errores de ESCRITURA en Google Calendar (tabla de codigos del spike T2.1) y
 * reintentos en linea acotados. Solo codigos cortos: nunca ids, emails ni datos de eventos.
 *
 * | Google                                   | kind            |
 * |------------------------------------------|-----------------|
 * | 401, 403 insufficientPermissions         | (no se clasifica aqui: GoogleAuthError not_connected) |
 * | 403 rateLimitExceeded/userRateLimit/quota, 429 | rate_limited |
 * | otro 403 (calendario de solo lectura...) | forbidden       |
 * | 412 failedPrecondition (etag viejo)      | conflict        |
 * | 409 duplicate (insert con id repetido)   | duplicate       |
 * | 404                                      | not_found       |
 * | 410 deleted                              | gone            |
 * | 400                                      | bad_request     |
 * | 5xx, red/timeout (status 0)              | transient       |
 */
export type WriteErrorKind =
  | 'read_only' // calendario reader/freeBusyReader en D1: no se llama a Google
  | 'calendar_not_found' // calendario inexistente o desaparecido en D1: no se llama a Google
  | 'invalid_payload' // campos invalidos (no se llama a Google)
  | 'forbidden'
  | 'rate_limited'
  | 'conflict'
  | 'duplicate'
  | 'not_found'
  | 'gone'
  | 'bad_request'
  | 'transient'
  | 'bad_response';

export class GoogleWriteError extends Error {
  readonly kind: WriteErrorKind;
  readonly status: number | null;
  readonly reason: string | null;
  constructor(kind: WriteErrorKind, status: number | null = null, reason: string | null = null) {
    super(`google_write_${kind}`);
    this.name = 'GoogleWriteError';
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

export const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
  'variableTermLimitExceeded',
]);

/**
 * Razones de un 403 que indican falta de permiso de escritura en el CALENDARIO (y justifican
 * bajar su rol en D1). Ausente = 403 sin motivo. `forbiddenForNonOrganizer` (evento ajeno) y las
 * razones desconocidas NO cuentan.
 */
export const CALENDAR_PERMISSION_REASONS: ReadonlySet<string> = new Set([
  'forbidden',
  'requiredAccessLevel',
]);

export function isCalendarPermissionReason(reason: string | null | undefined): boolean {
  return !reason || CALENDAR_PERMISSION_REASONS.has(reason);
}

/** 401, o 403 insufficientPermissions: token/permisos invalidos (se trata como desconectado). */
export function isAuthRejection(e: unknown): boolean {
  return (
    e instanceof GoogleApiError &&
    (e.status === 401 || (e.status === 403 && e.reason === 'insufficientPermissions'))
  );
}

export function classifyWriteError(e: unknown): WriteErrorKind {
  if (e instanceof GoogleWriteError) return e.kind;
  if (e instanceof PayloadError) return 'invalid_payload';
  if (!(e instanceof GoogleApiError)) return 'transient';
  const { status, reason } = e;
  if (status === 0 || status >= 500) return 'transient';
  if (status === 429) return 'rate_limited';
  if (status === 403)
    return reason && RATE_LIMIT_REASONS.has(reason) ? 'rate_limited' : 'forbidden';
  if (status === 412) return 'conflict';
  if (status === 409) return 'duplicate';
  if (status === 404) return 'not_found';
  if (status === 410) return 'gone';
  if (status === 400) return 'bad_request';
  return 'bad_response';
}

export function toWriteError(e: unknown): GoogleWriteError {
  if (e instanceof GoogleWriteError) return e;
  const kind = classifyWriteError(e);
  return e instanceof GoogleApiError
    ? new GoogleWriteError(kind, e.status, e.reason)
    : new GoogleWriteError(kind);
}

// ---------------------------------------------------------------------------------------------
// Reintentos en linea (solo `transient`): max 2, backoff exponencial con jitter.

export const MAX_INLINE_RETRIES = 2;
const RETRY_BASE_MS = 300;
const RETRY_MAX_MS = 2_000;

/** Espera antes del reintento n (1..): base*2^(n-1), con jitter +-50%, acotada. */
export function retryDelayMs(attempt: number, rand: number = Math.random()): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
  return Math.round(Math.min(base * (0.5 + rand), RETRY_MAX_MS));
}

export interface RetryOptions {
  /** Reintentos maximos tras el primer intento (0..MAX_INLINE_RETRIES). */
  retries?: number;
  /** Inyectable en tests. */
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ejecuta `fn` reintentando solo errores transitorios (5xx/red), nunca 4xx ni cuota. */
export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = Math.max(0, Math.min(opts.retries ?? MAX_INLINE_RETRIES, MAX_INLINE_RETRIES));
  const sleep = opts.sleep ?? realSleep;
  const rand = opts.rand ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const transient = e instanceof GoogleApiError && classifyWriteError(e) === 'transient';
      if (attempt >= retries || !transient) {
        throw e;
      }
      console.warn('google_write', 'retry', attempt + 1);
      await sleep(retryDelayMs(attempt + 1, rand()));
    }
  }
}
