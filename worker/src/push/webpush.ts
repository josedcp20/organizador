import { fromBase64Url, toBase64Url } from '../crypto/encoding';

/**
 * Web Push sin dependencias (D8/U1): cifrado aes128gcm (RFC 8291 + RFC 8188) y VAPID (RFC 8292)
 * con WebCrypto. Verificado contra el vector del RFC 8291 Apendice A (test/webpush.test.ts).
 * Nada de este modulo registra en consola: maneja la clave VAPID y el contenido del push.
 */

const enc = new TextEncoder();

/** Payload JSON maximo antes de cifrar (un unico registro de 4096 bytes cifrados). */
export const PAYLOAD_MAX = 3000;
/** Vida del JWT VAPID (Apple/FCM/Mozilla aceptan <= 24 h). */
export const VAPID_JWT_TTL_S = 3600;
const RECORD_SIZE = 4096;

export interface VapidKey {
  /** JWK privado P-256 completo (kty, crv, x, y, d). */
  jwk: JsonWebKey;
  /** Clave publica sin comprimir (0x04||x||y) en base64url: la `applicationServerKey` de la PWA. */
  publicKey: string;
}

function b64(s: unknown, len: number): Uint8Array | null {
  if (typeof s !== 'string') return null;
  const b = fromBase64Url(s);
  return b && b.length === len ? b : null;
}

/** Clave publica sin comprimir (65 bytes, empieza por 0x04) a partir de un JWK EC P-256. */
export function publicKeyFromJwk(jwk: JsonWebKey): Uint8Array {
  const x = b64(jwk.x, 32);
  const y = b64(jwk.y, 32);
  if (!x || !y) throw new Error('invalid_jwk');
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 33);
  return out;
}

/**
 * Valida el secreto `VAPID_PRIVATE_KEY` (JSON de un JWK privado P-256). null si falta o es
 * invalido. La publica se deriva del mismo JWK: no pueden desincronizarse.
 */
export function parseVapidKey(raw: string | undefined): VapidKey | null {
  if (!raw) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const k = j as Record<string, unknown>;
  if (k.kty !== 'EC' || k.crv !== 'P-256' || !b64(k.d, 32) || !b64(k.x, 32) || !b64(k.y, 32)) {
    return null;
  }
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: k.x as string,
    y: k.y as string,
    d: k.d as string,
  };
  return { jwk, publicKey: toBase64Url(publicKeyFromJwk(jwk)) };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Cabecera `Authorization: vapid t=<jwt>, k=<publica>` para un endpoint. `aud` = origen del
 * endpoint, `exp` = ahora + 1 h, `sub` = VAPID_SUBJECT. La firma ES256 de WebCrypto ya es r||s.
 */
export async function vapidAuthHeader(
  endpoint: string,
  key: VapidKey,
  subject: string,
  nowMs: number,
): Promise<string> {
  const header = toBase64Url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(nowMs / 1000) + VAPID_JWT_TTL_S,
        sub: subject,
      }),
    ),
  );
  const signing = `${header}.${claims}`;
  const priv = await crypto.subtle.importKey(
    'jwk',
    key.jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    priv,
    enc.encode(signing),
  );
  return `vapid t=${signing}.${toBase64Url(new Uint8Array(sig))}, k=${key.publicKey}`;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    k,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

export interface EncryptOptions {
  /** SOLO tests (vector RFC 8291): sal fija de 16 bytes. */
  salt?: Uint8Array;
  /** SOLO tests (vector RFC 8291): par efimero del servidor como JWK privado P-256. */
  localJwk?: JsonWebKey;
}

/**
 * Cifra `plaintext` para la suscripcion (`p256dh` 65 bytes, `auth` 16 bytes) en un unico
 * registro aes128gcm: salt(16)||rs(4)=4096||idlen(1)=65||as_public(65)||ciphertext.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: Uint8Array,
  auth: Uint8Array,
  opts: EncryptOptions = {},
): Promise<Uint8Array> {
  if (p256dh.length !== 65 || p256dh[0] !== 0x04) throw new Error('invalid_p256dh');
  if (auth.length !== 16) throw new Error('invalid_auth');
  if (plaintext.length > RECORD_SIZE - 17) throw new Error('payload_too_large');
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('invalid_salt');

  const ecdh = { name: 'ECDH', namedCurve: 'P-256' } as const;
  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (opts.localJwk) {
    asPrivate = await crypto.subtle.importKey('jwk', opts.localJwk, ecdh, false, ['deriveBits']);
    asPublic = publicKeyFromJwk(opts.localJwk);
  } else {
    const pair = (await crypto.subtle.generateKey(ecdh, true, ['deriveBits'])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(
      (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
    );
  }
  const uaPublic = await crypto.subtle.importKey('raw', p256dh, ecdh, false, []);
  const ecdhSecret = new Uint8Array(
    // workers-types tipa el campo como `$public`; workerd lee `public` (WebCrypto estandar).
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaPublic } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      asPrivate,
      256,
    ),
  );

  // RFC 8291 3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info"||0x00||ua_public||as_public, 32)
  const keyInfo = concat(enc.encode('WebPush: info\0'), p256dh, asPublic);
  const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);
  // RFC 8188 2.2/2.3
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(plaintext, new Uint8Array([0x02])); // delimitador del ultimo registro, sin relleno
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, record),
  );

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

export interface PushTarget {
  endpoint: string;
  /** base64url */
  p256dh: string;
  /** base64url */
  auth: string;
}

export interface PushMessage {
  v: 1;
  title: string;
  body: string;
  /** Ruta hash de la PWA (empieza por `#/`). */
  url: string;
  tag?: string;
}

export interface PushRequestOptions {
  ttl: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  /** <= 32 caracteres base64url (RFC 8030 5.4). */
  topic?: string;
  /** Resultado de `vapidAuthHeader` para el origen del endpoint. */
  authorization: string;
}

const TOPIC_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Peticion lista para `fetch`. Siempre `redirect: 'manual'` (`'error'` rompe en Workers). */
export async function buildPushRequest(
  sub: PushTarget,
  message: PushMessage,
  opts: PushRequestOptions,
): Promise<{ url: string; init: RequestInit }> {
  const plaintext = enc.encode(JSON.stringify(message));
  if (plaintext.length > PAYLOAD_MAX) throw new Error('payload_too_large');
  if (opts.topic !== undefined && !TOPIC_RE.test(opts.topic)) throw new Error('invalid_topic');
  const p256dh = fromBase64Url(sub.p256dh);
  const auth = fromBase64Url(sub.auth);
  if (!p256dh || !auth) throw new Error('invalid_keys');
  const body = await encryptPayload(plaintext, p256dh, auth);
  const headers: Record<string, string> = {
    Authorization: opts.authorization,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(Math.max(0, Math.floor(opts.ttl))),
    Urgency: opts.urgency,
  };
  if (opts.topic) headers.Topic = opts.topic;
  return { url: sub.endpoint, init: { method: 'POST', headers, body, redirect: 'manual' } };
}
