import { env } from 'cloudflare:workers';
import { ALARM_PUSH_TEXT, NOTE_ALARM_LIMITS } from '@organizador/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { toBase64Url } from '../src/crypto/encoding';
import { acquireLock } from '../src/db/jobLock';
import type { Env } from '../src/env';
import { ALARM_LOCK_KEY, runAlarms } from '../src/jobs/alarms';
import {
  DEFAULT_STEPS,
  runScheduled,
  SUBREQUEST_LIMIT,
  type StepContext,
} from '../src/jobs/scheduled';
import { publicKeyFromJwk } from '../src/push/webpush';

const T = Date.parse('2026-10-27T17:30:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SECRET = 'comprar pan secreto';

const APPLE = 'https://web.push.apple.com/QGuQyavXutnMtxJl9l0nV7G5gZQ2ZQ';
const FCM = 'https://fcm.googleapis.com/fcm/send/abc:APA91bHun4MxP5egoKMwt2KZFBaFUH';

const enc = new TextEncoder();
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, n: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const i = typeof info === 'string' ? enc.encode(info) : info;
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: i }, k, n * 8),
  );
}

/** Receptor aes128gcm independiente (como webpush.test.ts). */
async function decrypt(body: Uint8Array, uaJwk: JsonWebKey, auth: Uint8Array): Promise<string> {
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

let VAPID: string;
let UA: { jwk: JsonWebKey; auth: Uint8Array };
let E: Env;
let fetchMock: ReturnType<typeof vi.fn>;
let respond: (url: string) => Response | Promise<Response>;
let logs: string[];

async function addSub(endpoint: string, createdAt = iso(T - 1000)) {
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_label, created_at, fail_count)
     VALUES (?1, ?2, ?3, 'x', ?4, 0)`,
  )
    .bind(endpoint, toBase64Url(publicKeyFromJwk(UA.jwk)), toBase64Url(UA.auth), createdAt)
    .run();
}

async function addAlarm(
  id: string,
  remindAt: number,
  extra: { attempts?: number; expiresAt?: string | null; state?: string } = {},
) {
  await env.DB.prepare(
    `INSERT INTO notes (id, body, kind, expires_at, created_at, updated_at, remind_at, remind_state, remind_attempts)
     VALUES (?1, ?2, 'quick', ?3, ?4, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id,
      SECRET,
      extra.expiresAt ?? null,
      iso(T - 60 * MIN),
      iso(remindAt),
      extra.state ?? 'pending',
      extra.attempts ?? 0,
    )
    .run();
}

const note = (id: string) =>
  env.DB.prepare('SELECT remind_at, remind_state, remind_attempts FROM notes WHERE id = ?1')
    .bind(id)
    .first<{ remind_at: string | null; remind_state: string | null; remind_attempts: number }>();

const subs = async () =>
  (
    await env.DB.prepare(
      'SELECT endpoint, fail_count, last_error FROM push_subscriptions ORDER BY endpoint',
    ).all<{ endpoint: string; fail_count: number; last_error: string | null }>()
  ).results;

const run = (ms = T, e: Env = E, budget?: number) => {
  setClock(() => ms);
  return runAlarms(e, ms, budget);
};

beforeEach(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair;
  VAPID = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
  const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  UA = {
    jwk: (await crypto.subtle.exportKey('jwk', ua.privateKey)) as JsonWebKey,
    auth: crypto.getRandomValues(new Uint8Array(16)),
  };
  E = { ...env, VAPID_PRIVATE_KEY: VAPID } as Env;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_subscriptions'),
    env.DB.prepare('DELETE FROM job_state'),
    env.DB.prepare('DELETE FROM notes'),
  ]);
  respond = () => new Response(null, { status: 201 });
  fetchMock = vi.fn(async (input: RequestInfo | URL) => respond(String(input)));
  vi.stubGlobal('fetch', fetchMock);
  logs = [];
  for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
  }
});

afterEach(() => {
  // Ningun log lleva el id ni el texto de la nota.
  for (const l of logs) {
    expect(l).not.toMatch(/n-[a-z0-9]+/);
    expect(l).not.toContain(SECRET);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setClock();
});

describe('runAlarms: envio', () => {
  it('alarma vencida -> un push por suscripcion con payload fijo, Urgency high, TTL 6 h; queda sent', async () => {
    await addSub(APPLE);
    await addSub(FCM);
    await addAlarm('n-a1', T - MIN);
    const r = await run();
    expect(r).toMatchObject({ status: 'ok', requests: 2, counts: { sent: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      const h = new Headers(init.headers);
      expect(h.get('Urgency')).toBe('high');
      expect(h.get('TTL')).toBe(String(NOTE_ALARM_LIMITS.retryWindowMs / 1000));
      expect(h.get('Topic')).toBeNull();
      const text = await decrypt(init.body as Uint8Array, UA.jwk, UA.auth);
      expect(text).not.toContain(SECRET);
      expect(JSON.parse(text)).toEqual({
        v: 1,
        title: ALARM_PUSH_TEXT,
        body: ALARM_PUSH_TEXT,
        url: '#/notas?nota=n-a1',
        tag: 'alarm-n-a1',
      });
    }
    expect(await note('n-a1')).toMatchObject({ remind_state: 'sent', remind_attempts: 0 });
  });

  it('no duplica: la segunda ejecucion (o una perdida que se recupera) no reenvia', async () => {
    await addSub(APPLE);
    await addAlarm('n-a1', T - 25 * MIN); // dos ejecuciones del cron perdidas: se recoge igual
    await run();
    await run(T + 10 * MIN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dos ejecuciones simultaneas -> un solo envio', async () => {
    await addSub(APPLE);
    await addAlarm('n-a1', T - MIN);
    setClock(() => T);
    const rs = await Promise.all([runAlarms(E, T), runAlarms(E, T)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rs.reduce((n, r) => n + r.counts.sent, 0)).toBe(1);
    expect((await note('n-a1'))!.remind_state).toBe('sent');
  });

  it('una ejecucion que leyo antes del lock relee dentro: no reenvia lo ya marcado', async () => {
    await addSub(APPLE);
    await addAlarm('n-a1', T - MIN);
    // B toma el lock "despues" de que A termine: A ya marco sent -> B no envia.
    await run();
    const b = await run(T + 1000);
    expect(b.status).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('futura, de otro estado o nota caducada: no se envia', async () => {
    await addSub(APPLE);
    await addAlarm('n-fut', T + MIN);
    await addAlarm('n-sent', T - MIN, { state: 'sent' });
    await addAlarm('n-exp', T - MIN, { expiresAt: iso(T - 1) });
    expect((await run()).status).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await note('n-fut'))!.remind_state).toBe('pending');
  });

  it('cambio de hora: 02:30 local del 2026-10-25 (2a ocurrencia) suena a las 01:30Z, no antes', async () => {
    await addSub(APPLE);
    const at = Date.parse('2026-10-25T01:30:00.000Z');
    await addAlarm('n-dst', at);
    await run(at - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await run(at);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('mas de perRun vencidas: las mas antiguas primero, el resto en el siguiente run', async () => {
    await addSub(APPLE);
    for (let i = 0; i < 4; i++) await addAlarm(`n-${i}`, T - (10 - i) * MIN);
    expect((await run()).counts.sent).toBe(NOTE_ALARM_LIMITS.perRun);
    expect((await note('n-3'))!.remind_state).toBe('pending');
    for (let i = 0; i < 3; i++) expect((await note(`n-${i}`))!.remind_state).toBe('sent');
    await run(T + 10 * MIN);
    expect((await note('n-3'))!.remind_state).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('presupuesto: una alarma reserva maxSubscriptions peticiones; sin presupuesto no hace nada', async () => {
    await addSub(APPLE);
    for (let i = 0; i < 3; i++) await addAlarm(`n-${i}`, T - (10 - i) * MIN);
    expect((await run(T, E, 4)).status).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await run(T, E, 10)).counts.sent).toBe(2);
  });
});

describe('runAlarms: CAS contra ediciones', () => {
  it('editar la alarma durante el envio: no se marca sent y la nueva queda pendiente', async () => {
    await addSub(APPLE);
    await addAlarm('n-a1', T - MIN);
    const later = iso(T + 60 * MIN);
    respond = async () => {
      await env.DB.prepare(
        "UPDATE notes SET remind_at = ?2, remind_state = 'pending', remind_attempts = 0 WHERE id = ?1",
      )
        .bind('n-a1', later)
        .run();
      return new Response(null, { status: 201 });
    };
    expect((await run()).counts).toMatchObject({ sent: 0, skipped: 1 });
    expect(await note('n-a1')).toEqual({
      remind_at: later,
      remind_state: 'pending',
      remind_attempts: 0,
    });
  });

  it('quitar la alarma durante un envio fallido: no se reescribe', async () => {
    await addSub(APPLE);
    await addAlarm('n-a1', T - MIN);
    respond = async () => {
      await env.DB.prepare(
        'UPDATE notes SET remind_at = NULL, remind_state = NULL, remind_attempts = 0 WHERE id = ?1',
      )
        .bind('n-a1')
        .run();
      return new Response(null, { status: 503 });
    };
    await run();
    expect(await note('n-a1')).toEqual({
      remind_at: null,
      remind_state: null,
      remind_attempts: 0,
    });
  });
});

describe('runAlarms: gave_up', () => {
  it('retraso > retryWindowMs -> gave_up sin enviar (en el limite aun envia)', async () => {
    await addSub(APPLE);
    await addAlarm('n-late', T - NOTE_ALARM_LIMITS.retryWindowMs - 1);
    await addAlarm('n-edge', T - NOTE_ALARM_LIMITS.retryWindowMs);
    const r = await run();
    expect(r.counts).toMatchObject({ gave_up: 1, sent: 1 });
    expect((await note('n-late'))!.remind_state).toBe('gave_up');
    expect((await note('n-edge'))!.remind_state).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs).toContain('alarm gave_up missed');
  });

  it('attempts >= maxAttempts -> gave_up sin enviar', async () => {
    await addSub(APPLE);
    await addAlarm('n-a1', T - MIN, { attempts: NOTE_ALARM_LIMITS.maxAttempts });
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await note('n-a1'))!.remind_state).toBe('gave_up');
    expect(logs).toContain('alarm gave_up attempts');
  });

  it('sin suscripciones -> gave_up', async () => {
    await addAlarm('n-a1', T - MIN);
    await run();
    expect((await note('n-a1'))!.remind_state).toBe('gave_up');
    expect(logs).toContain('alarm gave_up no_subscriptions');
  });

  it('sin VAPID -> gave_up sin enviar', async () => {
    await addSub(APPLE);
    await addAlarm('n-a1', T - MIN);
    await run(T, { ...env, VAPID_PRIVATE_KEY: undefined } as unknown as Env);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await note('n-a1'))!.remind_state).toBe('gave_up');
    expect(logs).toContain('alarm gave_up no_vapid');
  });

  it('todas las suscripciones muertas (410) -> se purgan y gave_up', async () => {
    await addSub(APPLE);
    await addSub(FCM);
    await addAlarm('n-a1', T - MIN);
    respond = () => new Response(null, { status: 410 });
    await run();
    expect(await subs()).toEqual([]);
    expect((await note('n-a1'))!.remind_state).toBe('gave_up');
  });
});

describe('runAlarms: fallos y reintentos', () => {
  it('503 -> sigue pending con attempts+1 y se reenvia en el siguiente run', async () => {
    await addSub(APPLE);
    await addAlarm('n-a1', T - MIN);
    respond = () => new Response(null, { status: 503 });
    expect((await run()).counts.retry).toBe(1);
    expect(await note('n-a1')).toMatchObject({ remind_state: 'pending', remind_attempts: 1 });
    expect((await subs())[0]).toMatchObject({ fail_count: 1, last_error: 'retry_503' });
    respond = () => new Response(null, { status: 201 });
    await run(T + 10 * MIN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await note('n-a1')).toMatchObject({ remind_state: 'sent', remind_attempts: 1 });
  });

  it('una entrega ok y otra fallida -> sent; la muerta (404) se purga', async () => {
    await addSub(APPLE);
    await addSub(FCM);
    await addAlarm('n-a1', T - MIN);
    respond = (url) => new Response(null, { status: url.startsWith(APPLE) ? 201 : 404 });
    await run();
    expect((await note('n-a1'))!.remind_state).toBe('sent');
    expect((await subs()).map((s) => s.endpoint)).toEqual([APPLE]);
  });

  it('error de red en todas -> retry; al llegar a maxAttempts se rinde', async () => {
    await addSub(APPLE);
    await addAlarm('n-a1', T - MIN, { attempts: NOTE_ALARM_LIMITS.maxAttempts - 1 });
    fetchMock.mockImplementation(async () => {
      throw new TypeError('network');
    });
    await run();
    expect(await note('n-a1')).toMatchObject({
      remind_state: 'pending',
      remind_attempts: NOTE_ALARM_LIMITS.maxAttempts,
    });
    await run(T + 10 * MIN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await note('n-a1'))!.remind_state).toBe('gave_up');
  });
});

describe('runAlarms: lock y escrituras', () => {
  it('lock alarm_lock ocupado -> busy, sin enviar; libre otra vez -> envia', async () => {
    await addSub(APPLE);
    await addAlarm('n-a1', T - MIN);
    expect(await acquireLock(env.DB, ALARM_LOCK_KEY, 60_000, T)).not.toBeNull();
    expect((await run()).status).toBe('busy');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await note('n-a1'))!.remind_state).toBe('pending');
    await env.DB.prepare('DELETE FROM job_state').run();
    await run(T + 10 * MIN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('suelta el lock al terminar (tambien si falla)', async () => {
    await addSub(APPLE);
    await addAlarm('n-a1', T - MIN);
    await run();
    const broken = {
      ...E,
      VAPID_PRIVATE_KEY: VAPID,
      DB: new Proxy(env.DB, {
        get(t, p) {
          if (p === 'prepare')
            return (sql: string) => {
              if (sql.includes('FROM push_subscriptions')) throw new Error('d1');
              return t.prepare(sql);
            };
          const v = Reflect.get(t, p) as unknown;
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }),
    } as Env;
    await addAlarm('n-a2', T - MIN);
    await expect(run(T, broken)).rejects.toThrow('d1');
    expect(await env.DB.prepare('SELECT * FROM job_state').all()).toMatchObject({ results: [] });
    expect((await note('n-a2'))!.remind_state).toBe('pending');
  });

  it('sin alarmas vencidas -> 0 escrituras D1 (ni lock)', async () => {
    await addSub(APPLE);
    await addAlarm('n-fut', T + MIN);
    const sqls: string[] = [];
    const spyEnv = {
      ...E,
      DB: new Proxy(env.DB, {
        get(t, p) {
          if (p === 'prepare')
            return (sql: string) => {
              sqls.push(sql);
              return t.prepare(sql);
            };
          const v = Reflect.get(t, p) as unknown;
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }),
    } as Env;
    expect((await run(T, spyEnv)).status).toBe('idle');
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toMatch(/^\s*SELECT/);
  });
});

describe('cron */10', () => {
  it('alarms es el primer paso de DEFAULT_STEPS y agota el presupuesto (U8) tras enviar', async () => {
    const names = DEFAULT_STEPS.map((s) => s.name);
    expect(names[0]).toBe('alarms');
    expect(names).toContain('sync');
    await addSub(APPLE);
    await addSub(FCM);
    await addAlarm('n-a1', T - MIN);
    let seen: StepContext | null = null;
    setClock(() => T);
    const r = await runScheduled(E, T, [
      DEFAULT_STEPS[0]!,
      {
        name: 'after',
        run: async (ctx) => {
          seen = { ...ctx };
        },
      },
    ]);
    expect(r.failed).toEqual([]);
    expect(seen!.reserved).toBe(SUBREQUEST_LIMIT);
    expect((await note('n-a1'))!.remind_state).toBe('sent');
  });

  it('un fallo de alarms no impide los pasos siguientes', async () => {
    await addAlarm('n-a1', T - MIN);
    let ran = false;
    const r = await runScheduled({ ...E, DB: undefined } as unknown as Env, T, [
      DEFAULT_STEPS[0]!,
      {
        name: 'after',
        run: async () => {
          ran = true;
        },
      },
    ]);
    expect(r.failed).toEqual(['alarms']);
    expect(ran).toBe(true);
  });
});
