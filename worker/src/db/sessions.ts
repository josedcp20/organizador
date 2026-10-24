import { PASSKEY_LIMITS } from '@organizador/shared';
import { randomBytes, toBase64Url } from '../crypto/encoding';
import { sha256Hex } from '../middleware/auth';

export const SESSION_PREFIX = 's1.';
/** `s1.` + 32 bytes en base64url sin relleno (43 caracteres). */
const SESSION_RE = /^s1\.[A-Za-z0-9_-]{43}$/;
/** `last_used_at` se refresca como mucho una vez al dia. */
export const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface SessionRow {
  tokenHash: string;
  passkeyId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export function isSessionToken(token: string | null | undefined): token is string {
  return !!token && token.startsWith(SESSION_PREFIX);
}

/** Crea una sesion para `passkeyId`; devuelve el token en claro (solo se ve aqui) y su caducidad. */
export async function createSession(
  db: D1Database,
  passkeyId: string,
  nowMs: number,
): Promise<{ token: string; expiresAt: string }> {
  const token = SESSION_PREFIX + toBase64Url(randomBytes(32));
  const expiresAt = new Date(nowMs + PASSKEY_LIMITS.sessionTtlSeconds * 1000).toISOString();
  await db
    .prepare(
      'INSERT INTO sessions (token_hash, passkey_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)',
    )
    .bind(await sha256Hex(token), passkeyId, new Date(nowMs).toISOString(), expiresAt)
    .run();
  return { token, expiresAt };
}

/** Sesion vigente para el token, o null (mal formado, inexistente, caducada o revocada). */
export async function findSession(
  db: D1Database,
  token: string,
  nowMs: number,
): Promise<SessionRow | null> {
  if (!SESSION_RE.test(token)) return null;
  // Busqueda por hash de un secreto de 256 bits: no hay comparacion de cadenas que filtrar.
  const r = await db
    .prepare(
      `SELECT token_hash, passkey_id, created_at, expires_at, last_used_at
       FROM sessions WHERE token_hash = ?1 AND expires_at > ?2`,
    )
    .bind(await sha256Hex(token), new Date(nowMs).toISOString())
    .first<{
      token_hash: string;
      passkey_id: string;
      created_at: string;
      expires_at: string;
      last_used_at: string | null;
    }>();
  return r
    ? {
        tokenHash: r.token_hash,
        passkeyId: r.passkey_id,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        lastUsedAt: r.last_used_at,
      }
    : null;
}

/** Actualiza `last_used_at` solo si el ultimo uso (o la creacion) tiene mas de un dia. */
export async function touchSession(db: D1Database, s: SessionRow, nowMs: number): Promise<void> {
  const last = Date.parse(s.lastUsedAt ?? s.createdAt);
  if (nowMs - last < TOUCH_INTERVAL_MS) return;
  await db
    .prepare('UPDATE sessions SET last_used_at = ?2 WHERE token_hash = ?1')
    .bind(s.tokenHash, new Date(nowMs).toISOString())
    .run();
}

/** Revoca una sesion (por su token en claro). Devuelve true si existia. */
export async function deleteSession(db: D1Database, token: string): Promise<boolean> {
  const r = await db
    .prepare('DELETE FROM sessions WHERE token_hash = ?1')
    .bind(await sha256Hex(token))
    .run();
  return r.meta.changes > 0;
}

/** Revoca todas las sesiones. Devuelve cuantas. */
export async function deleteAllSessions(db: D1Database): Promise<number> {
  const r = await db.prepare('DELETE FROM sessions').run();
  return r.meta.changes;
}

/** Borra sesiones caducadas y nonces de challenge ya vencidos. */
export async function purgeExpired(
  db: D1Database,
  nowMs: number,
): Promise<{ sessions: number; challenges: number }> {
  const iso = new Date(nowMs).toISOString();
  const s = await db.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(iso).run();
  const c = await db
    .prepare('DELETE FROM webauthn_challenges_used WHERE expires_at <= ?1')
    .bind(iso)
    .run();
  return { sessions: s.meta.changes, challenges: c.meta.changes };
}
