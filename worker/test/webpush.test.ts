import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from '../src/crypto/encoding';
import {
  buildPushRequest,
  encryptPayload,
  parseVapidKey,
  PAYLOAD_MAX,
  publicKeyFromJwk,
  vapidAuthHeader,
  type PushMessage,
} from '../src/push/webpush';

const b = (s: string) => fromBase64Url(s.replace(/\s+/g, ''))!;
const enc = new TextEncoder();

// RFC 8291 Apendice A (valores copiados del RFC; los espacios son los del texto y se eliminan).
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV- JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ',
  // Seccion 5: cuerpo completo del mensaje
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function jwkFrom(publicRaw: Uint8Array, d: string): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: toBase64Url(publicRaw.slice(1, 33)),
    y: toBase64Url(publicRaw.slice(33, 65)),
    d,
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, n: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const i = typeof info === 'string' ? enc.encode(info) : info;
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: i }, k, n * 8),
  );
}

/** Receptor (navegador) independiente del modulo: descifra un cuerpo aes128gcm de un registro. */
async function decrypt(body: Uint8Array, uaJwk: JsonWebKey, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  expect(rs).toBe(4096);
  const idlen = body[20]!;
  expect(idlen).toBe(65);
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' } as const;
  const priv = await crypto.subtle.importKey('jwk', uaJwk, ecdh, false, ['deriveBits']);
  const pub = await crypto.subtle.importKey('raw', asPublic, ecdh, false, []);
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      priv,
      256,
    ),
  );
  const uaPublic = publicKeyFromJwk(uaJwk);
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(auth, secret, info, 32);
  const cek = await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  expect(pt[pt.length - 1]).toBe(0x02);
  return new TextDecoder().decode(pt.slice(0, -1));
}

async function newSubscriber() {
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' } as const;
  const pair = (await crypto.subtle.generateKey(ecdh, true, ['deriveBits'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { jwk, p256dh: publicKeyFromJwk(jwk), auth };
}

async function newVapidJwk(): Promise<JsonWebKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair;
  return (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
}

describe('encryptPayload (RFC 8291)', () => {
  it('reproduce byte a byte el vector del Apendice A', async () => {
    const plaintext = b(RFC.plaintext);
    expect(new TextDecoder().decode(plaintext)).toBe('When I grow up, I want to be a watermelon');
    const body = await encryptPayload(plaintext, b(RFC.uaPublic), b(RFC.authSecret), {
      salt: b(RFC.salt),
      localJwk: jwkFrom(b(RFC.asPublic), RFC.asPrivate),
    });
    expect(body.length).toBe(86 + b(RFC.ciphertext).length);
    expect(toBase64Url(body.slice(0, 86))).toBe(toBase64Url(b(RFC.header)));
    expect(toBase64Url(body.slice(86))).toBe(toBase64Url(b(RFC.ciphertext)));
    expect(toBase64Url(body)).toBe(RFC.message);
  });

  it('el receptor del RFC descifra el mensaje del vector', async () => {
    const ua = jwkFrom(b(RFC.uaPublic), RFC.uaPrivate);
    expect(await decrypt(b(RFC.message), ua, b(RFC.authSecret))).toBe(
      'When I grow up, I want to be a watermelon',
    );
  });

  it('ida y vuelta con clave efimera y sal aleatorias (dos cifrados distintos)', async () => {
    const s = await newSubscriber();
    const text = JSON.stringify({ v: 1, title: 'Hoy: 2 eventos', body: '09:30 Dentista ñ €' });
    const a = await encryptPayload(enc.encode(text), s.p256dh, s.auth);
    const c = await encryptPayload(enc.encode(text), s.p256dh, s.auth);
    expect(toBase64Url(a)).not.toBe(toBase64Url(c));
    expect(await decrypt(a, s.jwk, s.auth)).toBe(text);
    expect(await decrypt(c, s.jwk, s.auth)).toBe(text);
  });

  it('rechaza claves de tamano erroneo y texto que no cabe en un registro', async () => {
    const s = await newSubscriber();
    const pt = enc.encode('x');
    await expect(encryptPayload(pt, s.p256dh.slice(1), s.auth)).rejects.toThrow('invalid_p256dh');
    await expect(encryptPayload(pt, s.p256dh, s.auth.slice(1))).rejects.toThrow('invalid_auth');
    await expect(encryptPayload(new Uint8Array(4080), s.p256dh, s.auth)).rejects.toThrow(
      'payload_too_large',
    );
    // punto que no esta en la curva
    const bad = new Uint8Array(65);
    bad[0] = 4;
    await expect(encryptPayload(pt, bad, s.auth)).rejects.toThrow();
  });
});

describe('VAPID', () => {
  it('publicKeyFromJwk: 65 bytes que empiezan por 0x04 (= exportKey raw)', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
    );
    const pub = publicKeyFromJwk(jwk);
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(0x04);
    expect(toBase64Url(pub)).toBe(toBase64Url(raw));
  });

  it('parseVapidKey: acepta el JWK de gen:vapid y rechaza lo invalido', async () => {
    const jwk = await newVapidJwk();
    const k = parseVapidKey(JSON.stringify(jwk) + '\n');
    expect(k?.publicKey).toBe(toBase64Url(publicKeyFromJwk(jwk)));
    expect(parseVapidKey(undefined)).toBeNull();
    expect(parseVapidKey('')).toBeNull();
    expect(parseVapidKey('no json')).toBeNull();
    expect(parseVapidKey('null')).toBeNull();
    expect(parseVapidKey(JSON.stringify({ ...jwk, d: undefined }))).toBeNull();
    expect(parseVapidKey(JSON.stringify({ ...jwk, crv: 'P-384' }))).toBeNull();
    expect(parseVapidKey(JSON.stringify({ ...jwk, kty: 'RSA' }))).toBeNull();
    expect(parseVapidKey(JSON.stringify({ ...jwk, x: 'AAAA' }))).toBeNull();
  });

  it('JWT ES256: cabecera, aud = origen del endpoint, exp <= 1 h, sub y firma valida', async () => {
    const jwk = await newVapidJwk();
    const key = parseVapidKey(JSON.stringify(jwk))!;
    const nowMs = Date.UTC(2026, 9, 26, 8, 0, 0);
    const h = await vapidAuthHeader(
      'https://web.push.apple.com/QGuQyavXutnMtxJl9l0nV7G5gZQ2ZQ?x=1',
      key,
      'https://josedcp20.github.io/organizador/',
      nowMs,
    );
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
    expect(m).not.toBeNull();
    const [, hdr, claims, sig, k] = m!;
    const dec = (s: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(s)!));
    expect(dec(hdr!)).toEqual({ typ: 'JWT', alg: 'ES256' });
    const c = dec(claims!);
    expect(c.aud).toBe('https://web.push.apple.com');
    expect(c.sub).toBe('https://josedcp20.github.io/organizador/');
    expect(c.exp - nowMs / 1000).toBeGreaterThan(0);
    expect(c.exp - nowMs / 1000).toBeLessThanOrEqual(3600);
    expect(k).toBe(key.publicKey);
    const pub = await crypto.subtle.importKey(
      'raw',
      fromBase64Url(k!)!,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const signature = fromBase64Url(sig!)!;
    expect(signature.length).toBe(64); // r||s, no DER
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      signature,
      enc.encode(`${hdr}.${claims}`),
    );
    expect(ok).toBe(true);
  });

  it('aud de FCM incluye solo el origen', async () => {
    const key = parseVapidKey(JSON.stringify(await newVapidJwk()))!;
    const h = await vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc:APA91b', key, 's', 0);
    const claims = h.split(' ')[1]!.slice(2).split('.')[1]!;
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(claims)!)).aud).toBe(
      'https://fcm.googleapis.com',
    );
  });
});

describe('buildPushRequest', () => {
  const msg: PushMessage = { v: 1, title: 'T', body: 'B', url: '#/hoy', tag: 'digest-2026-10-26' };

  it('cabeceras RFC 8030/8291 y redirect manual; el cuerpo descifra al mensaje', async () => {
    const s = await newSubscriber();
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      p256dh: toBase64Url(s.p256dh),
      auth: toBase64Url(s.auth),
    };
    const { url, init } = await buildPushRequest(sub, msg, {
      ttl: 14400,
      urgency: 'high',
      topic: 'digest',
      authorization: 'vapid t=a.b.c, k=K',
    });
    expect(url).toBe(sub.endpoint);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({
      Authorization: 'vapid t=a.b.c, k=K',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '14400',
      Urgency: 'high',
      Topic: 'digest',
    });
    expect(JSON.parse(await decrypt(init.body as Uint8Array, s.jwk, s.auth))).toEqual(msg);
  });

  it('sin topic no manda Topic; topic invalido o payload > PAYLOAD_MAX lanzan', async () => {
    const s = await newSubscriber();
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      p256dh: toBase64Url(s.p256dh),
      auth: toBase64Url(s.auth),
    };
    const base = { ttl: 60, urgency: 'normal' as const, authorization: 'v' };
    const { init } = await buildPushRequest(sub, msg, base);
    expect((init.headers as Record<string, string>).Topic).toBeUndefined();
    await expect(buildPushRequest(sub, msg, { ...base, topic: 'a'.repeat(33) })).rejects.toThrow(
      'invalid_topic',
    );
    await expect(buildPushRequest(sub, msg, { ...base, topic: 'con espacio' })).rejects.toThrow();
    const big = { ...msg, body: 'x'.repeat(PAYLOAD_MAX) };
    await expect(buildPushRequest(sub, big, base)).rejects.toThrow('payload_too_large');
  });
});
