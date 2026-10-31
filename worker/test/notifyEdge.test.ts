import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import type { Env } from '../src/env';
import { DIGEST_MAX_ATTEMPTS, runNotify } from '../src/jobs/notify';
import { runScheduled } from '../src/jobs/scheduled';
import { connect, OAUTH_ENV } from './googleFake';
import { APPLE, setupPushFake, type PushFake } from './pushFake';

/** Casos limite de Fase 4 (U8, CPU, tope de intentos, banner, avisos con resumen fallido). */
let P: PushFake;
const T = Date.parse('2026-10-26T07:00:00Z'); // 08:00 CET

const log = (date: string) =>
  env.DB.prepare('SELECT * FROM digest_log WHERE date = ?1').bind(date).first<{
    status: string;
    attempts: number;
    last_error: string | null;
    acknowledged: number;
  }>();
const run = (iso: string) => {
  const ms = Date.parse(iso);
  setClock(() => ms);
  return runNotify(P.env, ms);
};
const pushFetches = () =>
  P.fetchMock.mock.calls.filter(([u]) => /push\.apple\.com|fcm\.googleapis/.test(String(u))).length;
const googleFetches = () =>
  P.fetchMock.mock.calls.filter(([u]) => /oauth2\.googleapis|www\.googleapis\.com/.test(String(u)))
    .length;

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
      'google_auth',
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.prepare(
    `INSERT INTO calendars (id, summary, google_color, color, enabled) VALUES ('a@x', 'a', '#9fe1e7', '#1a73e8', 1)`,
  ).run();
  P = await setupPushFake();
  for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setClock();
});

describe('cron completo: U8 y CPU', () => {
  const full = () => ({ ...P.env, ...OAUTH_ENV }) as Env;

  beforeEach(async () => {
    await connect();
    await P.addSub(APPLE);
    setClock(() => T);
  });

  it('tras un envio de notify: 0 fetch a Google; sin envio el sync si corre', async () => {
    await runScheduled(full(), T);
    expect(pushFetches()).toBe(1);
    expect(googleFetches()).toBe(0);
    await runScheduled(full(), T + 600_000); // resumen ya enviado
    expect(googleFetches()).toBeGreaterThan(0);
  });

  it('tras un envio de alarms: 0 fetch a Google y notify espera al siguiente cron', async () => {
    await env.DB.prepare(
      `INSERT INTO notes (id, body, kind, created_at, updated_at, remind_at, remind_state, remind_attempts)
       VALUES ('n1', 'x', 'quick', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z', '2026-10-26T06:50:00.000Z', 'pending', 0)`,
    ).run();
    await runScheduled(full(), T);
    expect(pushFetches()).toBe(1);
    expect(googleFetches()).toBe(0);
    expect(await log('2026-10-26')).toBeNull();
    await runScheduled(full(), T + 600_000);
    expect((await log('2026-10-26'))!.status).toBe('sent');
    expect(pushFetches()).toBe(2);
  });
});

describe('runNotify: intentos y estados limite', () => {
  it('tope de intentos escritos -> gave_up sin enviar', async () => {
    await P.addSub(APPLE);
    await env.DB.prepare(
      `INSERT INTO digest_log (date, status, attempts) VALUES ('2026-10-26', 'pending', ?1)`,
    )
      .bind(DIGEST_MAX_ATTEMPTS)
      .run();
    expect((await run('2026-10-26T07:00:00Z')).digest).toBe('give_up');
    expect(P.fetchMock).not.toHaveBeenCalled();
    expect(await log('2026-10-26')).toMatchObject({
      status: 'gave_up',
      last_error: 'max_attempts',
    });
  });

  it('un fallo suma un solo intento (anotado antes de enviar)', async () => {
    await P.addSub(APPLE);
    P.respond = () => new Response(null, { status: 503 });
    await run('2026-10-26T07:00:00Z');
    expect((await log('2026-10-26'))!.attempts).toBe(1);
  });

  it('gave_up desde failed reabre el banner (acknowledged = 0)', async () => {
    await P.addSub(APPLE);
    await env.DB.prepare(
      `INSERT INTO digest_log (date, status, attempts, last_error, acknowledged)
       VALUES ('2026-10-26', 'failed', 2, 'all_failed:retry_503', 1)`,
    ).run();
    await run('2026-10-26T11:00:00Z');
    expect(await log('2026-10-26')).toMatchObject({ status: 'gave_up', acknowledged: 0 });
  });

  it('failCode sale de esta ejecucion, no de otra suscripcion con mas fallos', async () => {
    await P.addSub(APPLE);
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, fail_count, last_error)
       VALUES ('https://web.push.apple.com/old', 'x', 'y', '2099-01-01T00:00:00.000Z', 99, 'stale_error')`,
    ).run();
    P.respond = () => new Response(null, { status: 503 });
    await run('2026-10-26T07:00:00Z');
    expect((await log('2026-10-26'))!.last_error).toBe('all_failed:retry_503');
  });

  it('sin suscripciones a las 12:00 y sin fila -> no_subscriptions (sin banner)', async () => {
    await run('2026-10-26T11:00:00Z');
    expect(await log('2026-10-26')).toMatchObject({ status: 'no_subscriptions', last_error: null });
  });

  it('el resumen falla y el aviso D-1 se envia igualmente', async () => {
    await P.addSub(APPLE);
    await env.DB.prepare(
      `INSERT INTO events (calendar_id, id, status, summary, all_day, start_date, end_date)
       VALUES ('a@x', 'r1', 'confirmed', 'Aviso', 1, '2026-10-27', '2026-10-27')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO event_meta (calendar_id, scope, target_id, remind, remind_days_before, updated_at)
       VALUES ('a@x', 'instance', 'r1', 1, 1, '2026-10-01T00:00:00Z')`,
    ).run();
    let n = 0;
    P.respond = () => new Response(null, { status: n++ === 0 ? 503 : 201 });
    const r = await run('2026-10-26T07:00:00Z');
    expect(r).toMatchObject({ digest: 'failed', reminders: 1 });
    expect((await P.payloads()).map((x) => x.tag)).toEqual([
      'digest-2026-10-26',
      'reminders-2026-10-26',
    ]);
  });
});
