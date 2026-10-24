import { fromBase64Url, randomBytes, timingSafeEqualBytes, toBase64Url } from './encoding';

/**
 * Tokens cortos firmados con HMAC-SHA256 (clave OAUTH_STATE_KEY) para el ticket de /start, el
 * `state` de OAuth, y challenges de WebAuthn (registro y login). Formato:
 * `v1.<nonce base64url>.<exp ms>.<firma base64url>`. La firma cubre el proposito (separacion de
 * dominio: un ticket no vale como state, y los challenges no valen uno por otro), el nonce y la
 * caducidad. La firma solo evita trabajo/escrituras con valores falsificados; el UN SOLO USO lo
 * garantiza el registro en D1 (ver google/oauthStore.ts, webauthn/challenge.ts).
 */
export type TokenPurpose = 'ticket' | 'state' | 'webauthn_reg' | 'webauthn_login';

const VERSION = 'v1';
const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
const EXP_RE = /^\d{1,16}$/;
const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

/** Importa OAUTH_STATE_KEY (>= 32 bytes en base64/base64url). null si falta o es corta. */
export async function importStateKey(raw: string | undefined): Promise<CryptoKey | null> {
  const value = raw?.trim();
  if (!value) return null;
  const bytes = fromBase64Url(value);
  if (!bytes || bytes.length < 32) return null;
  let key = keyCache.get(value);
  if (!key) {
    key = crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(value, key);
  }
  return key;
}

export function newNonce(): string {
  return toBase64Url(randomBytes(32));
}

async function mac(key: CryptoKey, purpose: TokenPurpose, nonce: string, exp: string) {
  const msg = `organizador/oauth/${purpose}/${VERSION}|${nonce}|${exp}`;
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(msg)));
}

export async function signToken(
  key: CryptoKey,
  purpose: TokenPurpose,
  nonce: string,
  expMs: number,
): Promise<string> {
  const exp = String(Math.floor(expMs));
  return `${VERSION}.${nonce}.${exp}.${toBase64Url(await mac(key, purpose, nonce, exp))}`;
}

export type VerifyResult =
  { ok: true; nonce: string; exp: number } | { ok: false; reason: 'invalid' | 'expired' };

/** Verifica formato, firma (tiempo constante) y caducidad, en ese orden. */
export async function verifyToken(
  key: CryptoKey,
  purpose: TokenPurpose,
  token: string | undefined | null,
  nowMs: number,
): Promise<VerifyResult> {
  if (typeof token !== 'string' || token.length > 256) return { ok: false, reason: 'invalid' };
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return { ok: false, reason: 'invalid' };
  const [, nonce = '', exp = '', sig = ''] = parts;
  if (!NONCE_RE.test(nonce) || !EXP_RE.test(exp)) return { ok: false, reason: 'invalid' };
  const given = fromBase64Url(sig);
  const expected = await mac(key, purpose, nonce, exp);
  if (!given || !timingSafeEqualBytes(given, expected)) return { ok: false, reason: 'invalid' };
  const expMs = Number(exp);
  if (!(expMs > nowMs)) return { ok: false, reason: 'expired' };
  return { ok: true, nonce, exp: expMs };
}
