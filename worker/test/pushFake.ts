import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { toBase64Url } from '../src/crypto/encoding';
import type { Env } from '../src/env';
import { publicKeyFromJwk } from '../src/push/webpush';

/** Servicio push simulado + receptor aes128gcm independiente (como alarms.test.ts / webpush.test.ts). */

export const APPLE = 'https://web.push.apple.com/QGuQyavXutnMtxJl9l0nV7G5gZQ2ZQ';
export const FCM = 'https://fcm.googleapis.com/fcm/send/abc:APA91bHun4MxP5egoKMwt2KZFBaFUH';

const enc = new TextEncoder();
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, n: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const i = typeof info === 'string' ? enc.encode(info) : info;
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: i }, k, n * 8),
  );
}

export interface PushFake {
  env: Env;
  fetchMock: ReturnType<typeof vi.fn>;
  /** Respuesta del servicio push por URL (por defecto 201). */
  respond: (url: string) => Response;
  addSub: (endpoint: string) => Promise<void>;
  /** Payloads descifrados de los fetch hechos, en orden. */
  payloads: () => Promise<Record<string, unknown>[]>;
  headers: () => Headers[];
}

export async function setupPushFake(): Promise<PushFake> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair;
  const vapid = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
  const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const uaJwk = (await crypto.subtle.exportKey('jwk', ua.privateKey)) as JsonWebKey;
  const auth = crypto.getRandomValues(new Uint8Array(16));

  async function decrypt(body: Uint8Array): Promise<string> {
    const salt = body.slice(0, 16);
    const idlen = body[20]!;
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
    const info = new Uint8Array([
      ...enc.encode('WebPush: info\0'),
      ...publicKeyFromJwk(uaJwk),
      ...asPublic,
    ]);
    const ikm = await hkdf(auth, secret, info, 32);
    const cek = await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
    const nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);
    const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
    return new TextDecoder().decode(pt.slice(0, -1));
  }

  const fake: PushFake = {
    env: { ...env, VAPID_PRIVATE_KEY: vapid } as Env,
    fetchMock: vi.fn(),
    respond: () => new Response(null, { status: 201 }),
    addSub: async (endpoint) => {
      await env.DB.prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_label, created_at, fail_count)
         VALUES (?1, ?2, ?3, 'x', '2026-01-01T00:00:00.000Z', 0)`,
      )
        .bind(endpoint, toBase64Url(publicKeyFromJwk(uaJwk)), toBase64Url(auth))
        .run();
    },
    payloads: () =>
      Promise.all(
        (fake.fetchMock.mock.calls as [string, RequestInit][]).map(async ([, init]) =>
          JSON.parse(await decrypt(init.body as Uint8Array)),
        ),
      ),
    headers: () =>
      (fake.fetchMock.mock.calls as [string, RequestInit][]).map(([, i]) => new Headers(i.headers)),
  };
  fake.fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
    fake.respond(String(input)),
  );
  vi.stubGlobal('fetch', fake.fetchMock);
  return fake;
}
