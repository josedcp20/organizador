import type { EventInfo, TodayResponse } from '@organizador/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { purgeOrphanDone } from '../src/db/eventDone';
import { call } from './helpers';

const ip = '203.0.113.41';
const CAL = 'a@x';
const NOW = Date.parse('2026-10-27T10:00:00.000Z');

async function addCal(id: string, role = 'owner') {
  await env.DB.prepare(
    `INSERT INTO calendars (id, summary, google_color, color, enabled, access_role) VALUES (?1, ?1, '#9fe1e7', '#1a73e8', 1, ?2)`,
  )
    .bind(id, role)
    .run();
}

async function addEvent(
  id: string,
  o: { cal?: string; recurring?: string | null; start?: string; op?: string | null } = {},
) {
  const start = o.start ?? '2026-10-27T12:00:00.000Z';
  await env.DB.prepare(
    `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at, recurring_event_id, origin, pending_op)
     VALUES (?1, ?2, 'confirmed', ?2, 0, ?3, ?4, ?5, 'google', ?6)`,
  )
    .bind(
      o.cal ?? CAL,
      id,
      start,
      new Date(Date.parse(start) + 3_600_000).toISOString(),
      o.recurring ?? null,
      o.op ?? null,
    )
    .run();
}

const path = (id: string, cal = CAL) =>
  `/api/agenda/${encodeURIComponent(cal)}/${encodeURIComponent(id)}`;
const put = (id: string, body: unknown, opts: { cal?: string; auth?: string | null } = {}) =>
  call(`${path(id, opts.cal)}/done`, {
    method: 'PUT',
    ip,
    auth: opts.auth,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const doneRows = async () =>
  (
    await env.DB.prepare('SELECT * FROM event_done ORDER BY event_id').all<{
      calendar_id: string;
      event_id: string;
      done_at: string;
    }>()
  ).results;
const get = async (id: string) => (await (await call(path(id), { ip })).json()) as EventInfo;

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  setClock(() => NOW);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM event_done'),
    env.DB.prepare('DELETE FROM event_meta'),
    env.DB.prepare('DELETE FROM events'),
    env.DB.prepare('DELETE FROM calendars'),
  ]);
  await addCal(CAL);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('PUT /done', () => {
  it('marca, devuelve EventInfo y done sale en detalle, agenda y hoy; sin Google', async () => {
    await addEvent('e1');
    await addEvent('e2', { start: '2026-10-27T13:00:00.000Z' });
    expect((await get('e1')).done).toBe(false);
    const res = await put('e1', { done: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as EventInfo).done).toBe(true);
    expect((await get('e1')).done).toBe(true);
    const ag = (await (await call('/api/agenda?from=2026-10-27&to=2026-10-27', { ip })).json()) as {
      events: EventInfo[];
    };
    expect(ag.events.map((e) => [e.id, e.done])).toEqual([
      ['e1', true],
      ['e2', false],
    ]);
    const today = (await (await call('/api/today', { ip })).json()) as TodayResponse;
    expect(today.todayEvents.map((e) => [e.id, e.done])).toEqual([
      ['e1', true],
      ['e2', false],
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('idempotente (conserva el primer done_at) y desmarcar borra la fila', async () => {
    await addEvent('e1');
    await put('e1', { done: true });
    const first = (await doneRows())[0]!.done_at;
    expect(first).toBe(new Date(NOW).toISOString());
    setClock(() => NOW + 60_000);
    expect((await put('e1', { done: true })).status).toBe(200);
    expect(await doneRows()).toEqual([{ calendar_id: CAL, event_id: 'e1', done_at: first }]);
    const r = await put('e1', { done: false });
    expect(((await r.json()) as EventInfo).done).toBe(false);
    expect(await doneRows()).toEqual([]);
    expect((await put('e1', { done: false })).status).toBe(200);
  });

  it('400 con body invalido y no escribe', async () => {
    await addEvent('e1');
    const bad = [
      'no json',
      {},
      { done: 'true' },
      { done: 1 },
      { done: null },
      { done: true, x: 1 },
      [true],
      'null',
    ];
    for (const b of bad) expect((await put('e1', b)).status).toBe(400);
    expect(await doneRows()).toEqual([]);
  });

  it('404 inexistente o borrado pendiente; 401 sin auth', async () => {
    await addEvent('e1', { op: 'delete' });
    expect((await put('nope', { done: true })).status).toBe(404);
    expect((await put('e1', { done: true })).status).toBe(404);
    expect((await put('e1', { done: true }, { auth: null })).status).toBe(401);
    expect(await doneRows()).toEqual([]);
  });

  it('funciona en calendario reader y en evento congelado', async () => {
    await addCal('r@x', 'reader');
    await addEvent('r1', { cal: 'r@x' });
    await addEvent('old', { start: '2020-01-01T10:00:00.000Z' });
    const r = (await (await put('r1', { done: true }, { cal: 'r@x' })).json()) as EventInfo;
    expect(r.done).toBe(true);
    const old = (await (await put('old', { done: true })).json()) as EventInfo;
    expect(old.frozen).toBe(true);
    expect(old.done).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('instancia de recurrente: marcar una no marca las demas', async () => {
    await addEvent('s_1', { recurring: 's' });
    await addEvent('s_2', { recurring: 's' });
    await put('s_1', { done: true });
    expect((await get('s_1')).done).toBe(true);
    expect((await get('s_2')).done).toBe(false);
  });

  it('sobrevive a cancelado/restaurado por sync y a un cambio de fecha del mismo id', async () => {
    await addEvent('e1');
    await put('e1', { done: true });
    await env.DB.prepare("UPDATE events SET status = 'cancelled' WHERE id = 'e1'").run();
    expect((await call(path('e1'), { ip })).status).toBe(404);
    await env.DB.prepare(
      "UPDATE events SET status = 'confirmed', start_at = '2026-10-28T09:00:00.000Z', end_at = '2026-10-28T10:00:00.000Z' WHERE id = 'e1'",
    ).run();
    expect((await get('e1')).done).toBe(true);
  });
});

describe('limpieza', () => {
  it('purgeOrphanDone borra solo huerfanas de mas de 90 dias', async () => {
    await addEvent('vivo');
    const ins = (id: string, at: string) =>
      env.DB.prepare('INSERT INTO event_done VALUES (?1, ?2, ?3)').bind(CAL, id, at).run();
    await ins('vivo', '2020-01-01T00:00:00.000Z');
    await ins('huerfano-viejo', '2026-06-01T00:00:00.000Z');
    await ins('huerfano-reciente', '2026-10-20T00:00:00.000Z');
    expect(await purgeOrphanDone(env.DB, NOW)).toBe(1);
    expect((await doneRows()).map((r) => r.event_id)).toEqual(['huerfano-reciente', 'vivo']);
  });
});
