/// <reference types="vite/client" />
import type { TodayResponse } from '@organizador/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { listRemindCandidates } from '../src/db/eventsRead';
import { runNotify } from '../src/jobs/notify';
import { call } from './helpers';
import { APPLE, setupPushFake, type PushFake } from './pushFake';

const ip = '203.0.113.31';

async function addCal(id: string, enabled = 1, removed: string | null = null) {
  await env.DB.prepare(
    `INSERT INTO calendars (id, summary, google_color, color, enabled, removed_at)
     VALUES (?1, ?1, '#9fe1e7', '#1a73e8', ?2, ?3)`,
  )
    .bind(id, enabled, removed)
    .run();
}

async function ev(
  cal: string,
  id: string,
  date: string,
  o: { series?: string; origin?: string; pending?: string | null } = {},
) {
  await env.DB.prepare(
    `INSERT INTO events (calendar_id, id, status, summary, all_day, start_date, end_date,
                         recurring_event_id, origin, pending_op)
     VALUES (?1, ?2, 'confirmed', ?2, 1, ?3, ?3, ?4, ?5, ?6)`,
  )
    .bind(cal, id, date, o.series ?? null, o.origin ?? 'google', o.pending ?? null)
    .run();
}

async function meta(
  cal: string,
  scope: 'instance' | 'series',
  target: string,
  remind: number,
  days: number | null = null,
) {
  await env.DB.prepare(
    `INSERT INTO event_meta (calendar_id, scope, target_id, remind, remind_days_before, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, '2026-10-01T00:00:00Z')`,
  )
    .bind(cal, scope, target, remind, days)
    .run();
}

const ids = async (from = '2026-10-24', to = '2026-12-22') =>
  (await listRemindCandidates(env.DB, from, to)).map((e) => e.id);

beforeEach(async () => {
  for (const t of ['event_done', 'event_meta', 'events', 'calendars']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  setClock(() => Date.parse('2026-10-23T10:00:00Z'));
  await addCal('a@x');
});
afterEach(() => setClock());

describe('listRemindCandidates', () => {
  it('flag de serie avisa cada instancia; override de instancia remind=0 excluye', async () => {
    await ev('a@x', 'i1', '2026-10-25', { series: 's' });
    await ev('a@x', 'i2', '2026-10-26', { series: 's' });
    await ev('a@x', 'i3', '2026-10-27', { series: 's' });
    await meta('a@x', 'series', 's', 1);
    await meta('a@x', 'instance', 'i2', 0);
    expect(await ids()).toEqual(['i1', 'i3']);
  });

  it('sin flag no es candidato; instancia remind=1 sin serie si', async () => {
    await ev('a@x', 'plain', '2026-10-25');
    await ev('a@x', 'on', '2026-10-26');
    await meta('a@x', 'instance', 'on', 1);
    expect(await ids()).toEqual(['on']);
  });

  it('respeta el rango y expone remindDaysBefore (defecto 5)', async () => {
    await ev('a@x', 'in', '2026-10-24');
    await ev('a@x', 'past', '2026-10-23');
    await ev('a@x', 'far', '2026-12-23');
    for (const id of ['in', 'past', 'far'])
      await meta('a@x', 'instance', id, 1, id === 'in' ? 2 : null);
    const r = await listRemindCandidates(env.DB, '2026-10-24', '2026-12-22');
    expect(r.map((e) => [e.id, e.remindDaysBefore])).toEqual([['in', 2]]);
  });

  it('excluye calendarios ocultos/eliminados, borrados pendientes y hechos; incluye app', async () => {
    await addCal('h@x', 0);
    await addCal('r@x', 1, '2026-10-01T00:00:00Z');
    await ev('h@x', 'hid', '2026-10-25');
    await ev('r@x', 'rem', '2026-10-25');
    await ev('a@x', 'del', '2026-10-25', { pending: 'delete' });
    await ev('a@x', 'done', '2026-10-25');
    await ev('a@x', 'app', '2026-10-25', { origin: 'app' });
    for (const [c, id] of [
      ['h@x', 'hid'],
      ['r@x', 'rem'],
      ['a@x', 'del'],
      ['a@x', 'done'],
      ['a@x', 'app'],
    ]) {
      await meta(c, 'instance', id, 1);
    }
    await env.DB.prepare(
      `INSERT INTO event_done (calendar_id, event_id, done_at) VALUES ('a@x','done','2026-10-23T00:00:00Z')`,
    ).run();
    expect(await ids()).toEqual(['app']);
  });
});

describe('/api/today reminders', () => {
  it('solo 1 <= inDays <= remindDaysBefore; hoy no avisa', async () => {
    await ev('a@x', 'today', '2026-10-23');
    await ev('a@x', 'd1', '2026-10-24');
    await ev('a@x', 'd5', '2026-10-28');
    await ev('a@x', 'd6', '2026-10-29');
    await ev('a@x', 'd3n2', '2026-10-26');
    for (const id of ['today', 'd1', 'd5', 'd6']) await meta('a@x', 'instance', id, 1);
    await meta('a@x', 'instance', 'd3n2', 1, 2);
    const b = (await (await call('/api/today', { ip })).json()) as TodayResponse;
    expect(b.reminders).toEqual([
      { calendarId: 'a@x', id: 'd1', summary: 'd1', date: '2026-10-24', inDays: 1 },
      { calendarId: 'a@x', id: 'd5', summary: 'd5', date: '2026-10-28', inDays: 5 },
    ]);
  });
});

describe('avisos D-N: envio en el paso notify', () => {
  let P: PushFake;
  const SECRET = 'CENTINELA-PRIVADO';
  /** 09:00 CEST del dia indicado (resumen ya enviado: solo cuentan los avisos). */
  const runAt = async (date: string, hourUtc = '07:00') => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO digest_log (date, status, attempts) VALUES (?1, 'sent', 1)`,
    )
      .bind(date)
      .run();
    const ms = Date.parse(`${date}T${hourUtc}:00Z`);
    setClock(() => ms);
    return runNotify(P.env, ms);
  };
  const logRows = async () =>
    (
      await env.DB.prepare(
        'SELECT event_id, start_key, status FROM reminder_log ORDER BY event_id, start_key',
      ).all<{ event_id: string; start_key: string; status: string }>()
    ).results;

  beforeEach(async () => {
    await env.DB.batch(
      ['push_subscriptions', 'job_state', 'digest_log', 'reminder_log'].map((t) =>
        env.DB.prepare(`DELETE FROM ${t}`),
      ),
    );
    P = await setupPushFake();
    await P.addSub(APPLE);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('D-5 por defecto: 1 aviso con url del evento; el D-6 no; sin repetir', async () => {
    await ev('a@x', 'd5', '2026-10-28');
    await ev('a@x', 'd6', '2026-10-29');
    await meta('a@x', 'instance', 'd5', 1);
    await meta('a@x', 'instance', 'd6', 1);
    await env.DB.prepare(`UPDATE events SET location = ?1, description = ?1`).bind(SECRET).run();
    await env.DB.prepare(`UPDATE event_meta SET notes = ?1`).bind(SECRET).run();
    expect((await runAt('2026-10-23')).reminders).toBe(1);
    const [p] = await P.payloads();
    expect(JSON.stringify(p)).not.toContain(SECRET);
    expect(p).toEqual({
      v: 1,
      title: 'En 5 días: d5',
      body: 'mié 28/10',
      url: '#/evento/a%40x/d5',
      tag: 'reminders-2026-10-23',
    });
    expect(P.headers()[0]!.get('Topic')).toBeNull();
    expect(await logRows()).toEqual([{ event_id: 'd5', start_key: '2026-10-28', status: 'sent' }]);
    await runAt('2026-10-23', '07:10');
    await runAt('2026-10-24'); // d5 ya avisado; d6 entra hoy (D-5)
    expect((await P.payloads()).map((x) => x.title)).toEqual(['En 5 días: d5', 'En 5 días: d6']);
  });

  it('N=2: a 3 dias no avisa, a 2 si', async () => {
    await ev('a@x', 'n2', '2026-10-26');
    await meta('a@x', 'instance', 'n2', 1, 2);
    await runAt('2026-10-23');
    expect(P.fetchMock).not.toHaveBeenCalled();
    await runAt('2026-10-24');
    expect((await P.payloads())[0]!.title).toBe('En 2 días: n2');
  });

  it('marcado tarde (K < N) -> "En K días"; cron caido el D-N -> avisa el D-(N-1)', async () => {
    await ev('a@x', 'late', '2026-10-26');
    await ev('a@x', 'down', '2026-10-29');
    await meta('a@x', 'instance', 'late', 1);
    await meta('a@x', 'instance', 'down', 1);
    // 2026-10-24 (D-5 de "down") no corrio el cron.
    await runAt('2026-10-25');
    expect((await P.payloads())[0]).toMatchObject({
      title: 'Próximos avisos (2)',
      body: 'En 1 día: late · En 4 días: down',
      url: '#/hoy',
    });
  });

  it('evento movido (nuevo start_key) re-avisa; desmarcado deja de avisar', async () => {
    await ev('a@x', 'mv', '2026-10-26');
    await ev('a@x', 'off', '2026-10-30');
    await meta('a@x', 'instance', 'mv', 1);
    await meta('a@x', 'instance', 'off', 1);
    await runAt('2026-10-23');
    expect(P.fetchMock).toHaveBeenCalledTimes(1);
    await env.DB.prepare(
      `UPDATE events SET start_date = '2026-10-27', end_date = '2026-10-27' WHERE id = 'mv'`,
    ).run();
    await runAt('2026-10-24');
    expect((await P.payloads())[1]!.title).toBe('En 3 días: mv');
    // "off" entra en rango el 25 pero se desmarca antes.
    await env.DB.prepare(`UPDATE event_meta SET remind = 0 WHERE target_id = 'off'`).run();
    await runAt('2026-10-25');
    expect(P.fetchMock).toHaveBeenCalledTimes(2);
    expect((await logRows()).map((r) => `${r.event_id}@${r.start_key}`)).toEqual([
      'mv@2026-10-26',
      'mv@2026-10-27',
    ]);
  });

  it('evento con hora: start_key = startAt; mover la hora re-avisa', async () => {
    await env.DB.prepare(
      `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at)
       VALUES ('a@x', 't1', 'confirmed', 'Examen', 0, '2026-10-27T08:30:00Z', '2026-10-27T10:00:00Z')`,
    ).run();
    await meta('a@x', 'instance', 't1', 1);
    await runAt('2026-10-23');
    expect((await P.payloads())[0]).toMatchObject({
      title: 'En 4 días: Examen',
      body: 'mar 27/10 09:30',
    });
    await env.DB.prepare(
      `UPDATE events SET start_at = '2026-10-27T09:30:00Z' WHERE id = 't1'`,
    ).run();
    await runAt('2026-10-24');
    expect(P.fetchMock).toHaveBeenCalledTimes(2);
    expect((await logRows()).map((r) => r.start_key)).toEqual([
      '2026-10-27T08:30:00Z',
      '2026-10-27T09:30:00Z',
    ]);
  });

  it('serie + override de instancia remind=0, evento de la app y evento hecho: 3 agrupados', async () => {
    await ev('a@x', 's1', '2026-10-24', { series: 'S' });
    await ev('a@x', 's2', '2026-10-25', { series: 'S' });
    await ev('a@x', 's3', '2026-10-26', { series: 'S' });
    await ev('a@x', 'app', '2026-10-27', { origin: 'app' });
    await ev('a@x', 'hecho', '2026-10-27');
    await meta('a@x', 'series', 'S', 1);
    await meta('a@x', 'instance', 's2', 0);
    await meta('a@x', 'instance', 'app', 1);
    await meta('a@x', 'instance', 'hecho', 1);
    await env.DB.prepare(
      `INSERT INTO event_done (calendar_id, event_id, done_at) VALUES ('a@x', 'hecho', '2026-10-22T00:00:00Z')`,
    ).run();
    await runAt('2026-10-23');
    expect(P.fetchMock).toHaveBeenCalledTimes(1);
    expect((await P.payloads())[0]).toEqual({
      v: 1,
      title: 'Próximos avisos (3)',
      body: 'En 1 día: s1 · En 3 días: s3 · En 4 días: app',
      url: '#/hoy',
      tag: 'reminders-2026-10-23',
    });
    expect((await logRows()).map((r) => r.event_id)).toEqual(['app', 's1', 's3']);
  });

  it('dia del evento no avisa', async () => {
    await ev('a@x', 'hoy', '2026-10-23');
    await meta('a@x', 'instance', 'hoy', 1);
    await runAt('2026-10-23');
    expect(P.fetchMock).not.toHaveBeenCalled();
  });

  it('fallo -> sin reminder_log -> reintento en el siguiente cron', async () => {
    await ev('a@x', 'r', '2026-10-25');
    await meta('a@x', 'instance', 'r', 1);
    P.respond = () => new Response(null, { status: 503 });
    expect((await runAt('2026-10-23')).reminders).toBe(0);
    expect(await logRows()).toEqual([]);
    P.respond = () => new Response(null, { status: 201 });
    expect((await runAt('2026-10-23', '07:10')).reminders).toBe(1);
    expect(P.fetchMock).toHaveBeenCalledTimes(2);
    expect(await logRows()).toHaveLength(1);
  });

  it('fuera de ventana (antes de 8:00 / desde las 12:00) no envia', async () => {
    await ev('a@x', 'r', '2026-10-25');
    await meta('a@x', 'instance', 'r', 1);
    await runAt('2026-10-23', '05:50'); // 07:50 CEST
    await runAt('2026-10-23', '10:00'); // 12:00 CEST
    expect(P.fetchMock).not.toHaveBeenCalled();
  });

  it('va despues del resumen en la misma ejecucion (2 push: resumen y avisos)', async () => {
    await ev('a@x', 'r', '2026-10-25');
    await meta('a@x', 'instance', 'r', 1);
    const ms = Date.parse('2026-10-23T06:00:00Z');
    setClock(() => ms);
    const res = await runNotify(P.env, ms);
    expect(res).toMatchObject({ digest: 'sent', reminders: 1, requests: 2 });
    expect((await P.payloads()).map((x) => x.tag)).toEqual([
      'digest-2026-10-23',
      'reminders-2026-10-23',
    ]);
  });
});
