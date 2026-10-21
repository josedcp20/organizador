import type { Context, MiddlewareHandler } from 'hono';
import { now } from '../clock';
import type { Env } from '../env';
import { errorBody } from '../errors';

export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60 * 1000;
export const BLOCK_MS = 15 * 60 * 1000;

/** Rutas bajo /api/* que no exigen token. (/oauth/* no cuelga de /api, asi que ya es publico.) */
const PUBLIC_API_PATHS = new Set(['/api/health']);

const HASH_RE = /^[0-9a-f]{64}$/i;
/** Separacion de dominio para derivar la clave HMAC de las IPs a partir de APP_TOKEN_SHA256. */
export const IP_KEY_DOMAIN = 'organizador/auth_failures/v1:';

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  let out = '';
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
}

/** Comparacion en tiempo constante respecto al contenido; recorre siempre max(len) bytes. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function verifyToken(header: string | undefined, expectedHash: string): Promise<boolean> {
  const token = extractBearer(header);
  // Se hace siempre el hash y la comparacion para no variar el coste segun el caso.
  const actual = await sha256Hex(token ?? '');
  const equal = timingSafeEqualStr(actual, expectedHash.toLowerCase());
  return token !== null && equal;
}

/**
 * Prefijo de red de una IPv6: los 4 primeros grupos (/64) normalizados, o null si no es una
 * IPv6 valida. Un /64 es la unidad que controla un solo cliente; indexar por IP completa
 * permitiria crear 2^64 filas y evadir el limite.
 */
export function ipv6Prefix64(ip: string): string | null {
  let s = ip.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  // IPv4 incrustada al final (::ffff:1.2.3.4) -> dos grupos hex.
  const m = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m) {
    const o = [m[2], m[3], m[4], m[5]].map(Number);
    if (o.some((n) => n > 255)) return null;
    const hi = ((o[0] ?? 0) << 8) | (o[1] ?? 0);
    const lo = ((o[2] ?? 0) << 8) | (o[3] ?? 0);
    s = `${m[1] ?? ''}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): string[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    return groups.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? groups : null;
  };
  const left = parse(halves[0] ?? '');
  const right = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (!left || !right) return null;
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  return groups
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':');
}

/** Identificador de cliente para el limite: IPv4 (o IPv4 mapeada en IPv6) tal cual, IPv6 por prefijo /64. */
export function clientId(ip: string): string {
  const v4 = mappedIpv4(ip);
  if (v4) return `v4:${v4}`;
  const p6 = ipv6Prefix64(ip);
  return p6 ? `v6:${p6}` : `v4:${ip.trim().toLowerCase()}`;
}

/** IPv4 mapeada en IPv6 (::ffff:a.b.c.d o ::ffff:hhhh:hhhh) -> "a.b.c.d"; null en otro caso. */
function mappedIpv4(ip: string): string | null {
  const s = ip.trim().toLowerCase();
  const dotted = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const o = dotted.slice(1, 5).map(Number);
    return o.every((n) => n <= 255) ? o.join('.') : null;
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hex) {
    const hi = parseInt(hex[1] ?? '', 16);
    const lo = parseInt(hex[2] ?? '', 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return null;
}

// CryptoKey cacheada por secreto (en la practica, un unico valor por despliegue).
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      'raw',
      encoder.encode(IP_KEY_DOMAIN + secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    hmacKeys.set(secret, k);
  }
  return k;
}

/**
 * Clave en D1: HMAC-SHA256(clave derivada de APP_TOKEN_SHA256, clientId) truncado a 32 hex.
 * Sin el secreto no se puede revertir (IPv4 tiene solo 2^32 valores).
 */
export async function ipKey(ip: string, secretHash: string): Promise<string> {
  const key = await hmacKey(secretHash.toLowerCase());
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(clientId(ip)));
  return toHex(sig).slice(0, 32);
}

/**
 * Borra filas caducadas de auth_failures (bloqueo vencido, o ventana vencida sin bloqueo).
 * TODO(T6.x/cron): llamarla desde scheduled() (p. ej. una vez al dia). Devuelve filas borradas.
 */
export async function purgeAuthFailures(db: D1Database, nowMs: number = now()): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM auth_failures
       WHERE (blocked_until IS NOT NULL AND blocked_until <= ?1)
          OR (blocked_until IS NULL AND window_start <= ?2)`,
    )
    .bind(new Date(nowMs).toISOString(), new Date(nowMs - WINDOW_MS).toISOString())
    .run();
  return res.meta.changes;
}

// Un solo UPSERT atomico: el incremento ocurre dentro de SQL, asi que una rafaga concurrente
// cuenta todos los fallos. "Caducado" = bloqueo vencido, o (sin bloqueo) ventana vencida.
// En SQLite todas las expresiones del SET ven la fila ANTERIOR. Las fechas son ISO-8601 UTC de
// longitud fija (toISOString), por lo que se comparan como texto. El bloqueo solo se fija si no
// habia uno vigente (no se prolonga). ?1 clave, ?2 ahora, ?3 limite de ventana, ?4 umbral,
// ?5 fin del bloqueo nuevo.
export const RECORD_FAILURE_SQL = `
INSERT INTO auth_failures (ip, window_start, count, blocked_until) VALUES (?1, ?2, 1, NULL)
ON CONFLICT(ip) DO UPDATE SET
  count = CASE
    WHEN (blocked_until IS NOT NULL AND blocked_until <= ?2)
      OR (blocked_until IS NULL AND window_start <= ?3) THEN 1
    ELSE count + 1 END,
  window_start = CASE
    WHEN (blocked_until IS NOT NULL AND blocked_until <= ?2)
      OR (blocked_until IS NULL AND window_start <= ?3) THEN ?2
    ELSE window_start END,
  blocked_until = CASE
    WHEN (blocked_until IS NOT NULL AND blocked_until <= ?2)
      OR (blocked_until IS NULL AND window_start <= ?3) THEN NULL
    WHEN blocked_until IS NULL AND count + 1 >= ?4 THEN ?5
    ELSE blocked_until END
RETURNING count, blocked_until`;

export interface FailureResult {
  count: number;
  blocked_until: string | null;
}

/** Registra un fallo (UPSERT atomico) para la clave `key` en el instante `t` (ms). */
export async function recordFailure(
  db: D1Database,
  key: string,
  t: number,
): Promise<FailureResult | null> {
  return db
    .prepare(RECORD_FAILURE_SQL)
    .bind(
      key,
      new Date(t).toISOString(),
      new Date(t - WINDOW_MS).toISOString(),
      MAX_FAILURES,
      new Date(t + BLOCK_MS).toISOString(),
    )
    .first<FailureResult>();
}

/** Tras un acierto: borra la fila salvo que tenga un bloqueo vigente (fijado por una rafaga). */
export async function resetFailures(db: D1Database, key: string, t: number): Promise<void> {
  await db
    .prepare(
      'DELETE FROM auth_failures WHERE ip = ?1 AND (blocked_until IS NULL OR blocked_until <= ?2)',
    )
    .bind(key, new Date(t).toISOString())
    .run();
}

function rateLimited(c: Context, untilIso: string, t: number): Response {
  const retry = Math.max(1, Math.ceil((Date.parse(untilIso) - t) / 1000));
  c.header('Retry-After', String(retry));
  return c.json(errorBody('rate_limited', 'Too many failed attempts'), 429);
}

function misconfigured(c: Context, code: string): Response {
  // Solo el codigo en el log; nunca valores de configuracion.
  console.error('auth_misconfigured', code);
  return c.json(errorBody('misconfigured', 'Server misconfigured'), 500);
}

// Los preflight OPTIONS los resuelve cors (montado antes) sin llegar aqui: cors es el unico
// responsable de ellos y auth no los trata.
export const auth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (PUBLIC_API_PATHS.has(c.req.path)) {
    return next();
  }

  // Fallo en cerrado y sin contar como intento: configuracion invalida.
  const secret = c.env.APP_TOKEN_SHA256?.trim();
  if (!secret || !HASH_RE.test(secret)) return misconfigured(c, 'bad_token_hash');

  // Sin CF-Connecting-IP (no pasa por Cloudflare) no hay cliente identificable: fuera de dev es
  // una anomalia (500, sin contar); en dev/tests se usa un bucket por defecto.
  const rawIp = c.req.header('CF-Connecting-IP')?.trim();
  if (!rawIp && c.env.ENV !== 'dev') return misconfigured(c, 'missing_client_ip');

  const t = now();
  const key = await ipKey(rawIp || 'unknown', secret);
  const db = c.env.DB;

  const row = await db
    .prepare('SELECT blocked_until FROM auth_failures WHERE ip = ?1')
    .bind(key)
    .first<{ blocked_until: string | null }>();

  if (row?.blocked_until && Date.parse(row.blocked_until) > t) {
    return rateLimited(c, row.blocked_until, t);
  }

  const ok = await verifyToken(c.req.header('Authorization'), secret);

  if (ok) {
    if (row) {
      await resetFailures(db, key, t);
    }
    return next();
  }

  const res = await recordFailure(db, key, t);

  // El fallo que alcanza el umbral (el 10o) da 401 y fija el bloqueo; los que lo superan (solo
  // posible en rafagas concurrentes) ya reciben 429.
  if (res && res.count > MAX_FAILURES && res.blocked_until) {
    return rateLimited(c, res.blocked_until, t);
  }
  return c.json(errorBody('unauthorized', 'Unauthorized'), 401);
};
