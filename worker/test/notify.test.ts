import type { TodayResponse } from '@organizador/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import type { Env } from '../src/env';
import { digestAction, NOTIFY_TTL_S, runNotify } from '../src/jobs/notify';
import {
  DEFAULT_STEPS,
  runScheduled,
  SUBREQUEST_LIMIT,
  type StepContext,
} from '../src/jobs/scheduled';
import { call } from './helpers';
import { APPLE, FCM, setupPushFake, type PushFake } from './pushFake';

const ip = '203.0.113.41';
const SECRET = 'CENTINELA-PRIVADO';
let P: PushFake;
let logs: string[];

const run = (isoNow: string, e: Env = P.env, budget?: number) => {
  const ms = Date.parse(isoNow);
  setClock(() => ms);
  return runNotify(e, ms, budget);
};

const log = (date: string) =>
  env.DB.prepare('SELECT * FROM digest_log WHERE date = ?1').bind(date).first<{
    status: string;
    attempts: number;
    last_error: string | null;
    sent_at: string | null;
    acknowledged: number;
  }>();

const pushFetches = () =>
  P.fetchMock.mock.calls.filter(([u]) => /push\.apple\.com|fcm\.googleapis/.test(String(u))).length;

beforeEach(async () => {
  await env.DB.batch(
    [
      'push_subscriptions',
      'job_state',
      'digest_log',
      'reminder_log',
      'notes',
      'event_meta',
      'events',
      'calendars',
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.prepare(
    `INSERT INTO calendars (id, summary, google_color, color, enabled) VALUES ('a@x', 'a', '#9fe1e7', '#1a73e8', 1)`,
  ).run();
  P = await setupPushFake();
  logs = [];
  for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
  }
});

afterEach(() => {
  for (const l of logs) expect(l).not.toContain(SECRET);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setClock();
});

describe('digestAction', () => {
  it.each([
    [7, null, 'wait'],
    [7, 'failed', 'wait'],
    [8, null, 'send'],
    [8, 'pending', 'send'],
    [11, 'failed', 'send'],
    [9, 'sent', 'done'],
    [9, 'gave_up', 'done'],
    [9, 'no_subscriptions', 'done'],
    [12, null, 'give_up'],
    [12, 'failed', 'give_up'],
    [12, 'pending', 'give_up'],
    [23, 'sent', 'done'],
    [12, 'no_subscriptions', 'done'],
  ] as const)('hora %i, fila %s -> %s', (hour, status, expected) => {
    expect(digestAction(hour, status ? { status } : null)).toBe(expected);
  });
});

describe('runNotify: hora local Europe/Madrid (DST)', () => {
  it.each([
    ['2026-10-24T06:00:00Z', 1], // 08:00 CEST
    ['2026-10-25T06:00:00Z', 0], // 07:00 CET, dia del cambio
    ['2026-10-25T07:00:00Z', 1], // 08:00 CET
    ['2026-10-26T06:50:00Z', 0], // 07:50 CET
    ['2026-10-26T07:00:00Z', 1],
    ['2026-03-28T07:00:00Z', 1], // 08:00 CET
    ['2026-03-29T06:00:00Z', 1], // 08:00 CEST, dia del cambio
    ['2026-03-29T05:59:00Z', 0], // 07:59 CEST
  ])('%s -> %i envio', async (t, n) => {
    await P.addSub(APPLE);
    await run(t);
    expect(P.fetchMock).toHaveBeenCalledTimes(n);
  });

  it('un solo resumen por dia: la siguiente ejecucion no reenvia', async () => {
    await P.addSub(APPLE);
    await run('2026-10-26T07:00:00Z');
    await run('2026-10-26T07:10:00Z');
    await run('2026-10-26T10:50:00Z');
    expect(P.fetchMock).toHaveBeenCalledTimes(1);
    expect(await log('2026-10-26')).toMatchObject({
      status: 'sent',
      attempts: 1,
      sent_at: '2026-10-26T07:00:00.000Z',
    });
  });
});

describe('runNotify: contenido y cabeceras', () => {
  it('payload con horas y titulos, sin notas/descripcion/ubicacion/notas rapidas; Topic digest', async () => {
    await env.DB.prepare(
      `INSERT INTO events (calendar_id, id, status, summary, location, description, all_day, start_at, end_at)
       VALUES ('a@x', 'e1', 'confirmed', 'Dentista', ?1, ?1, 0, '2026-10-26T08:30:00Z', '2026-10-26T09:00:00Z')`,
    )
      .bind(SECRET)
      .run();
    await env.DB.prepare(
      `INSERT INTO event_meta (calendar_id, scope, target_id, notes, updated_at)
       VALUES ('a@x', 'instance', 'e1', ?1, '2026-10-01T00:00:00Z')`,
    )
      .bind(SECRET)
      .run();
    await env.DB.prepare(
      `INSERT INTO notes (id, body, kind, created_at, updated_at) VALUES ('q1', ?1, 'quick', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z')`,
    )
      .bind(SECRET)
      .run();
    await P.addSub(APPLE);
    await run('2026-10-26T07:00:00Z');
    const [p] = await P.payloads();
    expect(JSON.stringify(p)).not.toContain(SECRET);
    expect(p).toEqual({
      v: 1,
      title: 'Hoy: 1 evento · Mañana: 0',
      body: '09:30 Dentista · 1 nota rápida',
      url: '#/hoy',
      tag: 'digest-2026-10-26',
    });
    const [h] = P.headers();
    expect(h!.get('Topic')).toBe('digest');
    expect(h!.get('Urgency')).toBe('high');
    expect(h!.get('TTL')).toBe(String(NOTIFY_TTL_S));
  });

  it('dia sin eventos: se envia igual con cuerpo no vacio', async () => {
    await P.addSub(APPLE);
    await run('2026-10-26T07:00:00Z');
    const [p] = await P.payloads();
    expect(p).toMatchObject({ title: 'Sin eventos hoy ni mañana', body: 'Sin eventos' });
  });
});

describe('runNotify: reintentos y estados', () => {
  it('fallo a las 08:00 + exito a las 08:10', async () => {
    await P.addSub(APPLE);
    P.respond = () => new Response(null, { status: 503 });
    expect((await run('2026-10-26T07:00:00Z')).digest).toBe('failed');
    expect(await log('2026-10-26')).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'all_failed:retry_503',
    });
    P.respond = () => new Response(null, { status: 201 });
    expect((await run('2026-10-26T07:10:00Z')).digest).toBe('sent');
    expect(await log('2026-10-26')).toMatchObject({
      status: 'sent',
      attempts: 2,
      last_error: null,
    });
    expect(P.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fallo continuo -> reintenta hasta 11:50 y a las 12:00 gave_up sin enviar', async () => {
    await P.addSub(APPLE);
    P.respond = () => new Response(null, { status: 503 });
    for (const t of ['07:00', '08:00', '10:50']) await run(`2026-10-26T${t}:00Z`);
    expect(P.fetchMock).toHaveBeenCalledTimes(3);
    expect((await run('2026-10-26T11:00:00Z')).digest).toBe('give_up');
    expect(P.fetchMock).toHaveBeenCalledTimes(3);
    expect(await log('2026-10-26')).toMatchObject({
      status: 'gave_up',
      attempts: 3,
      last_error: 'all_failed:retry_503',
    });
    await run('2026-10-26T11:10:00Z');
    expect(P.fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a las 12:00 sin fila -> gave_up missed_window, sin enviar', async () => {
    await P.addSub(APPLE);
    await run('2026-10-26T11:00:00Z');
    expect(P.fetchMock).not.toHaveBeenCalled();
    expect(await log('2026-10-26')).toMatchObject({
      status: 'gave_up',
      attempts: 0,
      last_error: 'missed_window',
    });
  });

  it('sin suscripciones -> no_subscriptions sin reintentos', async () => {
    await run('2026-10-26T07:00:00Z');
    expect(await log('2026-10-26')).toMatchObject({ status: 'no_subscriptions', attempts: 0 });
    await P.addSub(APPLE);
    expect((await run('2026-10-26T07:10:00Z')).status).toBe('idle');
    await run('2026-10-26T11:00:00Z');
    expect(P.fetchMock).not.toHaveBeenCalled();
    expect((await log('2026-10-26'))!.status).toBe('no_subscriptions');
  });

  it('exito parcial = sent', async () => {
    await P.addSub(APPLE);
    await P.addSub(FCM);
    P.respond = (u) => new Response(null, { status: u.startsWith(FCM) ? 503 : 201 });
    await run('2026-10-26T07:00:00Z');
    expect(P.fetchMock).toHaveBeenCalledTimes(2);
    expect((await log('2026-10-26'))!.status).toBe('sent');
  });

  it('excepcion al construir -> failed build_error (distinto de fallo de push) y reintenta', async () => {
    await P.addSub(APPLE);
    const broken = {
      ...P.env,
      DB: new Proxy(env.DB, {
        get(t, k) {
          if (k === 'prepare') {
            return (sql: string) => {
              if (/FROM notes/.test(sql)) throw new Error('boom');
              return t.prepare(sql);
            };
          }
          const v = Reflect.get(t, k);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }),
    } as Env;
    expect((await run('2026-10-26T07:00:00Z', broken)).digest).toBe('failed');
    expect(P.fetchMock).not.toHaveBeenCalled();
    expect(await log('2026-10-26')).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'build_error',
    });
    expect((await run('2026-10-26T07:10:00Z')).digest).toBe('sent');
  });

  it('presupuesto insuficiente -> no envia ni escribe; espera al siguiente cron', async () => {
    await P.addSub(APPLE);
    await P.addSub(FCM);
    const r = await run('2026-10-26T07:00:00Z', P.env, 1);
    expect(r.digest).toBe('no_budget');
    expect(P.fetchMock).not.toHaveBeenCalled();
    expect(await log('2026-10-26')).toBeNull();
  });
});

describe('cron: notify en runScheduled', () => {
  const T = Date.parse('2026-10-26T07:00:00Z');

  it('orden: alarms, notify, pending_writes, ... sync', () => {
    const names = DEFAULT_STEPS.map((s) => s.name);
    expect(names.slice(0, 3)).toEqual(['alarms', 'notify', 'pending_writes']);
    expect(names.indexOf('notify')).toBeLessThan(names.indexOf('sync'));
  });

  it('doble runScheduled en el mismo instante -> 1 envio', async () => {
    await P.addSub(APPLE);
    setClock(() => T);
    await runScheduled(P.env, T);
    await runScheduled(P.env, T);
    expect(pushFetches()).toBe(1);
  });

  it('dos runScheduled en Promise.all -> 1 envio', async () => {
    await P.addSub(APPLE);
    setClock(() => T);
    await Promise.all([runScheduled(P.env, T), runScheduled(P.env, T)]);
    expect(pushFetches()).toBe(1);
    expect((await log('2026-10-26'))!.status).toBe('sent');
  });

  it('U8: si se envia, los pasos siguientes ven el presupuesto agotado', async () => {
    await P.addSub(APPLE);
    setClock(() => T);
    const seen: number[] = [];
    const probe = { name: 'probe', run: async (c: StepContext) => void seen.push(c.reserved) };
    const notify = DEFAULT_STEPS.find((s) => s.name === 'notify')!;
    await runScheduled(P.env, T, [notify, probe]);
    await runScheduled(P.env, T + 600_000, [notify, probe]); // ya enviado: no reserva nada
    expect(seen).toEqual([SUBREQUEST_LIMIT, 0]);
  });
});

describe('POST /api/digest/ack y digestAlert', () => {
  const today = async () => (await (await call('/api/today', { ip })).json()) as TodayResponse;

  it('failed/gave_up de hoy no cerrado -> digestAlert; ack lo cierra', async () => {
    setClock(() => Date.parse('2026-10-26T12:00:00Z'));
    await env.DB.prepare(
      `INSERT INTO digest_log (date, status, attempts, last_error) VALUES ('2026-10-26', 'gave_up', 3, 'all_failed:retry_503')`,
    ).run();
    expect((await today()).digestAlert).toEqual({
      date: '2026-10-26',
      status: 'gave_up',
      lastError: 'all_failed:retry_503',
    });
    const r = await call('/api/digest/ack', { ip, method: 'POST' });
    expect(r.status).toBe(204);
    expect((await log('2026-10-26'))!.acknowledged).toBe(1);
    const b = await today();
    expect(b.digestAlert).toBeNull();
    expect(b.reminders).toEqual([]);
  });

  it('sent o sin fila -> digestAlert null; ack sin fila es idempotente', async () => {
    setClock(() => Date.parse('2026-10-26T12:00:00Z'));
    expect((await today()).digestAlert).toBeNull();
    expect((await call('/api/digest/ack', { ip, method: 'POST' })).status).toBe(204);
    await env.DB.prepare(
      `INSERT INTO digest_log (date, status, attempts) VALUES ('2026-10-26', 'sent', 1)`,
    ).run();
    expect((await today()).digestAlert).toBeNull();
  });

  it('ack exige auth', async () => {
    const r = await call('/api/digest/ack', { ip, method: 'POST', auth: null });
    expect(r.status).toBe(401);
  });
});
