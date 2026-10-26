import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { acquireLock } from '../src/db/jobLock';
import { CALENDAR_LIST_OK_KEY } from '../src/google/calendarList';
import {
  CALENDAR_REFRESH_EVERY_MS,
  CALENDAR_REFRESH_RETRY_MS,
  DEFAULT_STEPS,
  runScheduled,
} from '../src/jobs/scheduled';
import { SYNC_LOCK_KEY } from '../src/sync/engine';
import { connect, FakeGoogle, fullEnv, gError, NOW, OAUTH_ENV, resetDb } from './googleFake';
import { call } from './helpers';

const H = 3_600_000;
let google: FakeGoogle;
let fail: Response | null;
const steps = DEFAULT_STEPS.filter((s) => s.name === 'calendar_list_refresh');
const listCalls = () => google.requests.filter((r) => r.url.includes('/users/me/calendarList'));
const run = (ms: number, list = steps) => {
  setClock(() => ms);
  return runScheduled(fullEnv(), ms, list);
};
const count = async () =>
  (await env.DB.prepare('SELECT count(*) AS n FROM calendars').first<{ n: number }>())!.n;

beforeEach(async () => {
  await resetDb();
  google = new FakeGoogle();
  google.calendarList = [{ id: 'a@x', summary: 'A', accessRole: 'owner', selected: true }];
  fail = null;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (fail && url.includes('/users/me/calendarList')) {
        google.requests.push({ url, method: 'GET', headers: {}, body: null });
        return Promise.resolve(fail);
      }
      return google.handle(input, init);
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await connect();
});

describe('calendar_list_refresh', () => {
  it('corre la primera vez, no antes de 12 h y si despues', async () => {
    expect((await run(NOW)).failed).toEqual([]);
    expect(listCalls()).toHaveLength(1);
    expect(await count()).toBe(1);
    await run(NOW + CALENDAR_REFRESH_EVERY_MS - 1);
    expect(listCalls()).toHaveLength(1);
    await run(NOW + CALENDAR_REFRESH_EVERY_MS);
    expect(listCalls()).toHaveLength(2);
  });

  it('tras fallo espera 1 h y no bloquea el resto del cron', async () => {
    fail = gError(503, 'backendError');
    const order: string[] = [];
    const all = [...steps, { name: 'after', run: async () => void order.push('after') }];
    expect((await run(NOW, all)).failed).toEqual([]);
    expect(order).toEqual(['after']);
    await run(NOW + CALENDAR_REFRESH_RETRY_MS - 1);
    expect(listCalls()).toHaveLength(1);
    fail = null;
    await run(NOW + CALENDAR_REFRESH_RETRY_MS);
    expect(listCalls()).toHaveLength(2);
    expect(await count()).toBe(1);
  });

  it('Google no conectado: no falla el cron ni llama a Google', async () => {
    await env.DB.prepare('DELETE FROM google_auth').run();
    expect((await run(NOW)).failed).toEqual([]);
    expect(listCalls()).toHaveLength(0);
    await run(NOW + 10 * 60_000);
    await connect();
    await run(NOW + 20 * 60_000);
    expect(listCalls()).toHaveLength(0);
  });

  it('el boton manual actualiza la marca', async () => {
    setClock(() => NOW);
    const res = await call('/api/calendars/refresh', {
      method: 'POST',
      ip: '203.0.113.9',
      env: OAUTH_ENV,
    });
    expect(res.status).toBe(200);
    expect(listCalls()).toHaveLength(1);
    const mark = await env.DB.prepare('SELECT updated_at FROM job_state WHERE key = ?1')
      .bind(CALENDAR_LIST_OK_KEY)
      .first<{ updated_at: string }>();
    expect(mark?.updated_at).toBe(new Date(NOW).toISOString());
    await run(NOW + 11 * H);
    expect(listCalls()).toHaveLength(1);
  });

  it('respeta el lock: ocupado -> salta sin marcar', async () => {
    await acquireLock(env.DB, SYNC_LOCK_KEY, 5 * 60_000, NOW);
    await run(NOW + 1000);
    expect(listCalls()).toHaveLength(0);
    expect(
      await env.DB.prepare('SELECT 1 FROM job_state WHERE key = ?1')
        .bind(CALENDAR_LIST_OK_KEY)
        .first(),
    ).toBeNull();
  });

  it('respeta el presupuesto y suma lo gastado a reserved; corre antes del sync', async () => {
    const seen: number[] = [];
    const probe = {
      name: 'probe',
      run: async (c: { reserved: number }) => void seen.push(c.reserved),
    };
    await run(NOW, [{ name: 'big', run: async (c) => void (c.reserved += 30) }, ...steps, probe]);
    expect(listCalls()).toHaveLength(0); // 50-5-30-10 = 5 < 11
    await run(NOW, [...steps, probe]);
    expect(seen[1]).toBe(2); // token + 1 pagina
    expect(DEFAULT_STEPS.map((s) => s.name).indexOf('calendar_list_refresh')).toBeLessThan(
      DEFAULT_STEPS.map((s) => s.name).indexOf('sync'),
    );
  });
});
