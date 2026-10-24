import type { TokenPurpose } from '../crypto/signedToken';
import { signToken, verifyToken, newNonce } from '../crypto/signedToken';
import { now } from '../clock';
import { toBase64Url, fromBase64Url } from '../crypto/encoding';

/**
 * Emite un challenge de WebAuthn (token firmado) con proposito y TTL 5 min.
 * Retorna los bytes UTF-8 del token como base64url (para pasarlos a authenticator como challenge).
 * Sin escritura en D1 (permite precarga, sin vector de escrituras a anónimo).
 */
export async function issueChallenge(
  key: CryptoKey,
  purpose: 'webauthn_reg' | 'webauthn_login',
): Promise<string> {
  const nonce = newNonce();
  const nowMs = now();
  const ttlMs = 5 * 60 * 1000; // 5 min
  const expMs = nowMs + ttlMs;
  const token = await signToken(key, purpose as TokenPurpose, nonce, expMs);
  // El challenge es los bytes UTF-8 del token, codificados como base64url
  const encoder = new TextEncoder();
  const bytes = encoder.encode(token);
  return toBase64Url(bytes);
}

export type CheckChallengeResult =
  { ok: true; nonce: string; exp: number } | { ok: false; reason: 'invalid' | 'expired' };

/**
 * Verifica un challenge: decodifica base64url de clientDataJSON.challenge -> token firmado,
 * verifica firma + proposito + caducidad.
 * Retorna {ok, nonce, exp} o {ok: false, reason}.
 */
export async function checkChallenge(
  key: CryptoKey,
  purpose: 'webauthn_reg' | 'webauthn_login',
  b64url: string,
  nowMs: number,
): Promise<CheckChallengeResult> {
  // Decodificar base64url -> bytes -> string (token)
  const token = decodeBase64UrlToString(b64url);
  if (!token) return { ok: false, reason: 'invalid' };
  // Verificar firma + proposito + caducidad
  const result = await verifyToken(key, purpose as TokenPurpose, token, nowMs);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, nonce: result.nonce, exp: result.exp };
}

/**
 * Consume atomicamente el challenge: intenta insertar en webauthn_challenges_used.
 * Retorna true si se inserto (nonce no existia), false si ya existia (replay).
 * Usa ON CONFLICT DO NOTHING: si el nonce ya existe, la insercion se ignora silenciosamente.
 * meta.changes = 1 -> inserto exitosamente; meta.changes = 0 -> habia conflicto.
 */
export async function consumeChallenge(
  db: D1Database,
  nonce: string,
  exp: number,
): Promise<boolean> {
  const { meta } = await db
    .prepare(
      'INSERT INTO webauthn_challenges_used (nonce, expires_at) VALUES (?1, ?2) ON CONFLICT DO NOTHING',
    )
    .bind(nonce, new Date(exp).toISOString())
    .run();
  return meta.changes === 1;
}

/**
 * Helper interno: decodifica base64url a string UTF-8.
 */
function decodeBase64UrlToString(b64url: string): string | null {
  const bytes = fromBase64Url(b64url);
  if (!bytes) return null;
  try {
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}
