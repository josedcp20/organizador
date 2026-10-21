import { fromBase64Url, randomBytes, toBase64Url } from './encoding';

/**
 * Cifrado autenticado de secretos en D1 (refresh token y access token de Google).
 * AES-256-GCM con clave TOKEN_ENC_KEY (32 bytes, base64/base64url), IV aleatorio de 12 bytes
 * por cifrado y AAD con el contexto (un texto cifrado para un uso no se acepta en otro).
 *
 * Formato versionado: `v1.<iv base64url>.<ciphertext+tag base64url>`.
 */
export const BOX_VERSION = 'v1';
const IV_BYTES = 12;

export class SecretBoxError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'SecretBoxError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

/** Valida e importa TOKEN_ENC_KEY. null si falta o no son exactamente 32 bytes (fail-closed). */
export async function importEncKey(raw: string | undefined): Promise<CryptoKey | null> {
  const value = raw?.trim();
  if (!value) return null;
  const bytes = fromBase64Url(value);
  if (!bytes || bytes.length !== 32) return null;
  let key = keyCache.get(value);
  if (!key) {
    key = crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    keyCache.set(value, key);
  }
  return key;
}

export async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  );
  return `${BOX_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

/** Descifra; lanza SecretBoxError si el formato no es valido o el texto fue manipulado. */
export async function open(key: CryptoKey, boxed: string, aad: string): Promise<string> {
  const parts = boxed.split('.');
  if (parts.length !== 3 || parts[0] !== BOX_VERSION) throw new SecretBoxError('bad_format');
  const iv = fromBase64Url(parts[1] ?? '');
  const ct = fromBase64Url(parts[2] ?? '');
  // 16 bytes = tag GCM; un texto vacio cifrado ocupa exactamente eso.
  if (!iv || iv.length !== IV_BYTES || !ct || ct.length < 16) {
    throw new SecretBoxError('bad_format');
  }
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
      key,
      ct,
    );
    return decoder.decode(pt);
  } catch {
    throw new SecretBoxError('tampered');
  }
}
