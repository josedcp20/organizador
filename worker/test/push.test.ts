import { env } from 'cloudflare:workers';
import type { PushStatusResponse, PushTestResult } from '@organizador/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { toBase64Url } from '../src/crypto/encoding';
import {
  classifyPushResponse,
  parseSubscription,
  subscriptionId,
  validEndpoint,
  type StoredSubscription,
} from '../src/db/pushSubscriptions';
import { createSession } from '../src/db/sessions';
import type { Env } from '../src/env';
import { sendToAll } from '../src/push/send';
import { publicKeyFromJwk } from '../src/push/webpush';
import { type CallOptions, call as rawCall } from './helpers';

let VAPID: string;
let VAPID_PUB: string;
const call = (path: string, opts: CallOptions = {}) =>
  rawCall(path, { ip: '203.0.113.9', env: { VAPID_PRIVATE_KEY: VAPID }, ...opts });
const post = (path: string, body: unknown, opts: CallOptions = {}) =>
  call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...opts,
  });

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return {
    p256dh: toBase64Url(raw),
    auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

let K: { p256dh: string; auth: string };
const sub = (endpoint: string, extra: Record<string, unknown> = {}) => ({
  endpoint,
  expirationTime: null,
  keys: K,
  ...extra,
});
const APPLE = 'https://web.push.apple.com/QGuQyavXutnMtxJl9l0nV7G5gZQ2ZQ';
const FCM = 'https://fcm.googleapis.com/fcm/send/abc:APA91bHun4MxP5egoKMwt2KZFBaFUH';

async function rows(): Promise<StoredSubscription[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM push_subscriptions ORDER BY created_at',
  ).all<StoredSubscription>();
  return results;
}

let fetchMock: ReturnType<typeof vi.fn>;
let respond: (url: string) => Response | Promise<Response>;

beforeEach(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  VAPID = JSON.stringify(jwk);
  VAPID_PUB = toBase64Url(publicKeyFromJwk(jwk));
  K = await keys();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_subscriptions'),
    env.DB.prepare('DELETE FROM job_state'),
    env.DB.prepare('DELETE FROM auth_failures'),
    env.DB.prepare('DELETE FROM digest_log'),
  ]);
  respond = () => new Response(null, { status: 201 });
  fetchMock = vi.fn(async (input: RequestInfo | URL) => respond(String(input)));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setClock();
});

describe('validacion de suscripciones (SSRF)', () => {
  it('lista blanca de servicios push', () => {
    for (const ok of [
      APPLE,
      'https://api.push.apple.com/x',
      FCM,
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2b',
    ]) {
      expect(validEndpoint(ok), ok).not.toBeNull();
    }
    for (const bad of [
      'http://web.push.apple.com/x',
      'https://web.push.apple.com:8443/x',
      'https://web.push.apple.com:443/x',
      'https://user:pw@web.push.apple.com/x',
      'https://evil.com/x',
      'https://push.apple.com.evil.com/x',
      'https://evilpush.apple.com/x',
      'https://fcm.googleapis.com.evil.com/x',
      'https://notify.windows.com/x',
      'https://web.push.apple.com./x',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'javascript:alert(1)',
      'https://web.push.apple.com/' + 'a'.repeat(2048),
      42,
      null,
    ]) {
      expect(validEndpoint(bad), String(bad)).toBeNull();
    }
  });

  it('claves: p256dh 65 bytes con 0x04, auth 16 bytes; expirationTime numerico', () => {
    expect(parseSubscription(sub(APPLE))).toMatchObject({
      endpoint: APPLE,
      label: 'iPhone/Mac (Apple)',
      expiresAt: null,
    });
    expect(parseSubscription(sub(FCM, { expirationTime: Date.UTC(2027, 0, 1) }))).toMatchObject({
      label: 'Chrome/Edge',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    const p = Uint8Array.from(atob(K.p256dh.replace(/-/g, '+').replace(/_/g, '/') + '='), (c) =>
      c.charCodeAt(0),
    );
    const p03 = new Uint8Array(p);
    p03[0] = 3;
    const bad: unknown[] = [
      null,
      'x',
      { endpoint: APPLE },
      sub(APPLE, { keys: { p256dh: K.p256dh } }),
      sub(APPLE, { keys: { p256dh: toBase64Url(p.slice(1)), auth: K.auth } }),
      sub(APPLE, { keys: { p256dh: toBase64Url(p03), auth: K.auth } }),
      sub(APPLE, { keys: { p256dh: K.p256dh, auth: toBase64Url(new Uint8Array(15)) } }),
      sub(APPLE, { keys: { p256dh: K.p256dh, auth: '!!!' } }),
      sub(APPLE, { expirationTime: 'mañana' }),
      sub(APPLE, { expirationTime: -1 }),
      sub('https://evil.com/x'),
    ];
    for (const b of bad) expect(parseSubscription(b), JSON.stringify(b)).toHaveProperty('error');
  });

  it('clasificacion de respuestas (tabla 2.2)', () => {
    expect(classifyPushResponse(201)).toEqual({ kind: 'ok' });
    expect(classifyPushResponse(200)).toEqual({ kind: 'ok' });
    expect(classifyPushResponse(202)).toEqual({ kind: 'ok' });
    expect(classifyPushResponse(404)).toEqual({ kind: 'gone' });
    expect(classifyPushResponse(410)).toEqual({ kind: 'gone' });
    expect(classifyPushResponse(413)).toEqual({ kind: 'error', code: 'payload_too_large' });
    expect(classifyPushResponse(400)).toEqual({ kind: 'error', code: 'rejected_400' });
    expect(classifyPushResponse(403)).toEqual({ kind: 'error', code: 'rejected_403' });
    expect(classifyPushResponse(429)).toEqual({ kind: 'error', code: 'retry_429' });
    expect(classifyPushResponse(503)).toEqual({ kind: 'error', code: 'retry_503' });
    expect(classifyPushResponse(301)).toEqual({ kind: 'error', code: 'retry_301' });
    expect(classifyPushResponse('network')).toEqual({ kind: 'error', code: 'retry_network' });
  });
});

describe('/api/push/* auth y configuracion', () => {
  it('exigen token', async () => {
    for (const [method, path] of [
      ['GET', '/api/push/status'],
      ['POST', '/api/push/subscribe'],
      ['DELETE', '/api/push/subscribe'],
      ['POST', '/api/push/test'],
    ] as const) {
      const r = await call(path, { method, auth: null });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });

  it('sin VAPID: status configured=false; subscribe y test 503', async () => {
    const noKey: CallOptions = { env: { VAPID_PRIVATE_KEY: undefined } as Partial<Env> };
    const s = (await (await call('/api/push/status', noKey)).json()) as PushStatusResponse;
    expect(s.configured).toBe(false);
    expect(s.publicKey).toBeNull();
    expect((await post('/api/push/subscribe', sub(APPLE), noKey)).status).toBe(503);
    expect((await post('/api/push/test', {}, noKey)).status).toBe(503);
    const bad: CallOptions = { env: { VAPID_PRIVATE_KEY: '{"kty":"EC"}' } };
    expect(
      ((await (await call('/api/push/status', bad)).json()) as PushStatusResponse).configured,
    ).toBe(false);
  });
});

describe('/api/push/subscribe y /status', () => {
  it('alta idempotente; status sin endpoint ni claves, no-store, publicKey derivada', async () => {
    const r = await post('/api/push/subscribe', sub(APPLE));
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    expect(id).toBe(await subscriptionId(APPLE));
    expect((await post('/api/push/subscribe', sub(APPLE))).status).toBe(200);
    expect(await rows()).toHaveLength(1);

    const st = await call('/api/push/status');
    expect(st.headers.get('Cache-Control')).toBe('no-store');
    const text = await st.text();
    expect(text).not.toContain('web.push.apple.com');
    expect(text).not.toContain(K.p256dh);
    expect(text).not.toContain(K.auth);
    expect(text).not.toContain('"d"');
    const s = JSON.parse(text) as PushStatusResponse;
    expect(s).toMatchObject({
      configured: true,
      publicKey: VAPID_PUB,
      subject: 'https://josedcp20.github.io/organizador/',
      digest: null,
    });
    expect(s.subscriptions).toEqual([
      {
        id,
        label: 'iPhone/Mac (Apple)',
        createdAt: expect.any(String),
        lastOkAt: null,
        failCount: 0,
        lastError: null,
      },
    ]);
  });

  it('acepta sesion s1.* valida (middleware comun) y rechaza una invalida', async () => {
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM passkeys').run();
    await env.DB.prepare(
      "INSERT INTO passkeys (id, public_key, label, created_at) VALUES ('pk-push','k','iPhone','x')",
    ).run();
    const { token } = await createSession(env.DB, 'pk-push', Date.now());
    expect((await call('/api/push/status', { auth: `Bearer ${token}` })).status).toBe(200);
    expect((await call('/api/push/status', { auth: 'Bearer s1.invalida' })).status).toBe(401);
  });

  it('cambio de claves en el re-POST limpia fallos; mismas claves los conserva', async () => {
    await post('/api/push/subscribe', sub(APPLE));
    await env.DB.prepare(
      "UPDATE push_subscriptions SET fail_count = 3, last_error = 'rejected_403'",
    ).run();
    await post('/api/push/subscribe', sub(APPLE));
    expect((await rows())[0]).toMatchObject({ fail_count: 3, last_error: 'rejected_403' });
    K = await keys();
    await post('/api/push/subscribe', sub(APPLE));
    expect((await rows())[0]).toMatchObject({ fail_count: 0, last_error: null, p256dh: K.p256dh });
  });

  it('U9: la 6a suscripcion expulsa la de COALESCE(last_success_at, created_at) mas antigua', async () => {
    let t = Date.UTC(2026, 9, 1);
    setClock(() => t);
    for (let i = 0; i < 5; i++) {
      t += 60_000;
      expect((await post('/api/push/subscribe', sub(`${APPLE}${i}`))).status).toBe(200);
    }
    // La 0 es la mas antigua por created_at, pero tuvo un exito reciente: se expulsa la 1.
    await env.DB.prepare('UPDATE push_subscriptions SET last_success_at = ?1 WHERE endpoint = ?2')
      .bind(new Date(t).toISOString(), `${APPLE}0`)
      .run();
    t += 60_000;
    await post('/api/push/subscribe', sub(`${APPLE}5`));
    const eps = (await rows()).map((r) => r.endpoint);
    expect(eps).toHaveLength(5);
    expect(eps).not.toContain(`${APPLE}1`);
    expect(eps).toContain(`${APPLE}0`);
    expect(eps).toContain(`${APPLE}5`);
    // Re-POST de una existente no expulsa a nadie.
    await post('/api/push/subscribe', sub(`${APPLE}2`));
    expect(await rows()).toHaveLength(5);
  });

  it('rechaza endpoint fuera de lista blanca, JSON invalido y cuerpos grandes', async () => {
    expect((await post('/api/push/subscribe', sub('https://evil.com/x'))).status).toBe(400);
    expect(
      (
        await call('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{nope',
        })
      ).status,
    ).toBe(400);
    expect(
      (await post('/api/push/subscribe', { ...sub(APPLE), pad: 'x'.repeat(5000) })).status,
    ).toBe(413);
    expect(await rows()).toHaveLength(0);
  });

  it('cuerpo grande sin Content-Length -> 413 (mide bytes, no caracteres)', async () => {
    const big = JSON.stringify({ ...sub(APPLE), pad: 'é'.repeat(2500) });
    const res = await call('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({
        start(ctl) {
          ctl.enqueue(new TextEncoder().encode(big));
          ctl.close();
        },
      }) as unknown as BodyInit,
    });
    expect(res.status).toBe(413);
  });

  it('expirationTime se guarda como expires_at', async () => {
    await post('/api/push/subscribe', sub(FCM, { expirationTime: Date.UTC(2027, 0, 1) }));
    expect((await rows())[0]!.expires_at).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('DELETE /api/push/subscribe', () => {
  it('por endpoint (este dispositivo) y por id (otro); idempotente 204', async () => {
    await post('/api/push/subscribe', sub(APPLE));
    await post('/api/push/subscribe', sub(FCM));
    const del = (opts: CallOptions, q = '') =>
      call(`/api/push/subscribe${q}`, { method: 'DELETE', ...opts });
    expect(
      (
        await del({
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: APPLE }),
        })
      ).status,
    ).toBe(204);
    expect((await rows()).map((r) => r.endpoint)).toEqual([FCM]);
    expect((await del({}, `?id=${await subscriptionId(FCM)}`)).status).toBe(204);
    expect(await rows()).toHaveLength(0);
    expect((await del({}, `?id=${await subscriptionId(FCM)}`)).status).toBe(204);
    expect((await del({}, '?id=zz')).status).toBe(400);
    expect((await del({})).status).toBe(400);
  });
});

describe('POST /api/push/test', () => {
  async function twoSubs() {
    await post('/api/push/subscribe', sub(APPLE));
    await post('/api/push/subscribe', sub(FCM));
  }

  it('envia a todas: cabeceras, JWT por origen, redirect manual; exito actualiza la fila', async () => {
    await twoSubs();
    const r = await post('/api/push/test', {});
    expect(r.status).toBe(200);
    expect((await r.json()) as PushTestResult).toEqual({ sent: 2, failed: 0, removed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => String(c[0])).sort();
    expect(urls).toEqual([FCM, APPLE].sort());
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      const h = init.headers as Record<string, string>;
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('manual');
      expect(h['Content-Encoding']).toBe('aes128gcm');
      expect(h.TTL).toBe('60');
      expect(h.Urgency).toBe('normal');
      expect(h.Topic).toBeUndefined();
      expect(h.Authorization).toMatch(
        new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${VAPID_PUB}$`),
      );
    }
    const auds = (fetchMock.mock.calls as [string, RequestInit][]).map(([, i]) => {
      const t = (i.headers as Record<string, string>).Authorization!.split(/[ =,]/)[2]!;
      return JSON.parse(atob(t.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).aud;
    });
    expect(auds.sort()).toEqual(['https://fcm.googleapis.com', 'https://web.push.apple.com']);
    for (const row of await rows()) {
      expect(row.last_success_at).not.toBeNull();
      expect(row.fail_count).toBe(0);
    }
  });

  it('throttle: segunda prueba en < 30 s -> 429 con Retry-After; pasado el intervalo, OK', async () => {
    let t = Date.UTC(2026, 9, 26, 10);
    setClock(() => t);
    expect((await post('/api/push/test', {})).status).toBe(200);
    t += 10_000;
    const r = await post('/api/push/test', {});
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('30');
    t += 21_000;
    expect((await post('/api/push/test', {})).status).toBe(200);
  });

  it.each([
    [404, { removed: 1 }, null],
    [410, { removed: 1 }, null],
    [403, { failed: 1 }, 'rejected_403'],
    [400, { failed: 1 }, 'rejected_400'],
    [413, { failed: 1 }, 'payload_too_large'],
    [429, { failed: 1 }, 'retry_429'],
    [500, { failed: 1 }, 'retry_500'],
    [503, { failed: 1 }, 'retry_503'],
    [302, { failed: 1 }, 'retry_302'],
  ] as const)('respuesta %i', async (status, counts, lastError) => {
    await post('/api/push/subscribe', sub(APPLE));
    respond = () =>
      new Response(
        null,
        status === 302 ? { status, headers: { Location: 'https://evil.com' } } : { status },
      );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = (await (await post('/api/push/test', {})).json()) as PushTestResult;
    expect(r).toEqual({ sent: 0, failed: 0, removed: 0, ...counts });
    const left = await rows();
    if (lastError === null) expect(left).toHaveLength(0);
    else expect(left[0]).toMatchObject({ fail_count: 1, last_error: lastError });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Logs: solo host, status y codigo.
    expect(warn).toHaveBeenCalledWith(
      'push',
      'web.push.apple.com',
      String(status),
      lastError ?? 'gone',
    );
  });

  it('error de red: retry_network; ningun secreto en consola', async () => {
    await post('/api/push/subscribe', sub(APPLE));
    respond = () => {
      throw new TypeError('network down');
    };
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const r = (await (await post('/api/push/test', {})).json()) as PushTestResult;
    expect(r).toEqual({ sent: 0, failed: 1, removed: 0 });
    expect((await rows())[0]).toMatchObject({ last_error: 'retry_network' });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    const d = (JSON.parse(VAPID) as JsonWebKey).d!;
    for (const secret of [d, K.p256dh, K.auth, 'QGuQyavXutnMtxJl9l0nV7G5gZQ2ZQ', 'vapid t=']) {
      expect(logged).not.toContain(secret);
    }
  });

  it('suscripciones caducadas no reciben envios', async () => {
    setClock(() => Date.UTC(2026, 9, 26));
    await post('/api/push/subscribe', sub(APPLE, { expirationTime: Date.UTC(2026, 9, 25) }));
    await post('/api/push/subscribe', sub(FCM));
    const r = (await (await post('/api/push/test', {})).json()) as PushTestResult;
    expect(r.sent).toBe(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(FCM);
  });

  it('fila con endpoint invalido en D1: sin fetch, se borra y se sigue', async () => {
    await post('/api/push/subscribe', sub(APPLE));
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
       VALUES ('https://evil.com/x', ?1, ?2, ?3)`,
    )
      .bind(K.p256dh, K.auth, '2026-01-01T00:00:00.000Z')
      .run();
    const r = (await (await post('/api/push/test', {})).json()) as PushTestResult;
    expect(r).toEqual({ sent: 1, failed: 0, removed: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await rows()).map((x) => x.endpoint)).toEqual([APPLE]);
  });

  it('presupuesto maxSends: con 1 y 2 suscripciones solo 1 fetch', async () => {
    await twoSubs();
    const m = { v: 1 as const, title: 't', body: 'b', url: '#/hoy', tag: 'x' };
    const r = await sendToAll({ ...env, VAPID_PRIVATE_KEY: VAPID } as unknown as Env, m, {
      ttl: 60,
      urgency: 'normal',
      maxSends: 1,
    });
    expect(r).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('un fallo no impide enviar al resto', async () => {
    await twoSubs();
    respond = (url) => new Response(null, { status: url.startsWith(FCM) ? 410 : 201 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = (await (await post('/api/push/test', {})).json()) as PushTestResult;
    expect(r).toEqual({ sent: 1, failed: 0, removed: 1 });
    expect((await rows()).map((x) => x.endpoint)).toEqual([APPLE]);
  });
});
