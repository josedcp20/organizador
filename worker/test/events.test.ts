/// <reference types="vite/client" />
import type { EventsResponse, TodayResponse } from '@organizador/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { call } from './helpers';

const ip = '203.0.113.20';

async function addCal(id: string, extra: { enabled?: number; removed?: string | null } = {}) {
  await env.DB.prepare(
    `INSERT INTO calendars (id, summary, google_color, color, enabled, removed_at)
     VALUES (?1, ?1, '#9fe1e7', ?2, ?3, ?4)`,
  )
    .bind(id, id === 'a@x' ? '#1a73e8' : '#d93025', extra.enabled ?? 1, extra.removed ?? null)
    .run();
}

async function timed(cal: string, id: string, start: string, end: string) {
  await env.DB.prepare(
    `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at, origin)
     VALUES (?1, ?2, 'confirmed', ?2, 0, ?3, ?4, 'google')`,
  )
    .bind(cal, id, start, end)
    .run();
}

async function allDay(cal: string, id: string, start: string, endExclusive: string) {
  await env.DB.prepare(
    `INSERT INTO events (calendar_id, id, status, summary, all_day, start_date, end_date, origin)
     VALUES (?1, ?2, 'confirmed', ?2, 1, ?3, ?4, 'google')`,
  )
    .bind(cal, id, start, endExclusive)
    .run();
}

const get = (q: string) => call(`/api/events${q}`, { ip });
const ids = (r: EventsResponse) => r.events.map((e) => e.id);

beforeEach(async () => {
  for (const t of ['event_meta', 'events', 'calendars']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  setClock();
  await addCal('a@x');
});

afterEach(() => {
  setClock();
  vi.unstubAllGlobals();
});

describe('GET /api/events', () => {
  it('401 sin token en events y today', async () => {
    for (const p of ['/api/events?from=2026-10-01&to=2026-10-02', '/api/today']) {
      expect((await call(p, { ip, auth: null })).status).toBe(401);
    }
  });

  it('no llama a Google', async () => {
    const f = vi.fn(() => {
      throw new Error('fetch prohibido');
    });
    vi.stubGlobal('fetch', f);
    expect((await get('?from=2026-10-01&to=2026-10-02')).status).toBe(200);
    expect((await call('/api/today', { ip })).status).toBe(200);
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    [''],
    ['?from=2026-10-01'],
    ['?to=2026-10-01'],
    ['?from=2026-10-1&to=2026-10-02'],
    ['?from=2026-02-30&to=2026-03-02'],
    ['?from=2026-10-05&to=2026-10-04'],
    ['?from=2026-01-01&to=2027-02-05'], // 401 dias
    ['?from=abc&to=def'],
  ])('400 con parametros invalidos %s', async (q) => {
    const res = await get(q);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation');
    expect(typeof body.error.message).toBe('string');
  });

  it('acepta el rango maximo (400 dias) y el de un solo dia', async () => {
    expect((await get('?from=2026-01-01&to=2027-02-04')).status).toBe(200);
    expect((await get('?from=2026-01-01&to=2026-01-01')).status).toBe(200);
  });

  it('rango por solape, fechas en Madrid, orden por inicio', async () => {
    // Madrid en octubre = UTC+2: el 10-10 local va de 10-09T22:00Z a 10-10T22:00Z.
    await timed('a@x', 'before', '2026-10-09T20:00:00.000Z', '2026-10-09T21:59:59.000Z');
    await timed('a@x', 'ends-at-start', '2026-10-09T21:00:00.000Z', '2026-10-09T22:00:00.000Z');
    await timed('a@x', 'late-night', '2026-10-10T21:30:00.000Z', '2026-10-10T23:00:00.000Z');
    await timed('a@x', 'cross-in', '2026-10-09T21:00:00.000Z', '2026-10-09T22:00:01.000Z');
    await timed('a@x', 'noon', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await timed('a@x', 'after', '2026-10-10T22:00:00.000Z', '2026-10-10T23:00:00.000Z');
    const body = (await (await get('?from=2026-10-10&to=2026-10-10')).json()) as EventsResponse;
    expect(body.from).toBe('2026-10-10');
    expect(ids(body)).toEqual(['cross-in', 'noon', 'late-night']);
  });

  it('eventos de dia completo multi-dia (end exclusivo) y orden con los de hora', async () => {
    await allDay('a@x', 'trip', '2026-10-10', '2026-10-13'); // 10, 11, 12
    await allDay('a@x', 'one', '2026-10-12', '2026-10-13');
    await timed('a@x', 'm', '2026-10-12T07:00:00.000Z', '2026-10-12T08:00:00.000Z');
    const day = async (d: string) =>
      ids((await (await get(`?from=${d}&to=${d}`)).json()) as EventsResponse);
    expect(await day('2026-10-09')).toEqual([]);
    expect(await day('2026-10-10')).toEqual(['trip']);
    expect(await day('2026-10-11')).toEqual(['trip']);
    expect(await day('2026-10-12')).toEqual(['trip', 'one', 'm']);
    expect(await day('2026-10-13')).toEqual([]);
    const all = (await (await get('?from=2026-10-01&to=2026-10-31')).json()) as EventsResponse;
    expect(all.events[0]).toMatchObject({
      allDay: true,
      startDate: '2026-10-10',
      endDate: '2026-10-13',
      startAt: null,
    });
  });

  it('solo calendarios visibles y no eliminados; excluye cancelados y borrados pendientes', async () => {
    await addCal('hidden@x', { enabled: 0 });
    await addCal('gone@x', { removed: '2026-10-01T00:00:00.000Z' });
    await addCal('b@x');
    for (const c of ['a@x', 'hidden@x', 'gone@x', 'b@x']) {
      await timed(c, `e-${c}`, '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    }
    await timed('a@x', 'cancelled', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await env.DB.prepare("UPDATE events SET status='cancelled' WHERE id='cancelled'").run();
    await timed('a@x', 'pdel', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await env.DB.prepare("UPDATE events SET pending_op='delete' WHERE id='pdel'").run();
    const body = (await (await get('?from=2026-10-10&to=2026-10-10')).json()) as EventsResponse;
    expect(ids(body)).toEqual(['e-a@x', 'e-b@x']);
    expect(body.events.map((e) => [e.calendarId, e.color])).toEqual([
      ['a@x', '#1a73e8'],
      ['b@x', '#d93025'],
    ]);
  });

  it('incluye metadatos locales: instancia > serie > defecto, y color propio', async () => {
    await timed('a@x', 'plain', '2026-10-10T08:00:00.000Z', '2026-10-10T09:00:00.000Z');
    await env.DB.prepare(
      `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at, recurring_event_id)
       VALUES ('a@x','r1','confirmed','r1',0,'2026-10-10T10:00:00.000Z','2026-10-10T11:00:00.000Z','ser')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO event_meta (calendar_id, scope, target_id, notes, remind, remind_days_before, color, updated_at) VALUES
       ('a@x','series','ser','nota serie',1,10,'#00ff00','2026-10-01T00:00:00Z'),
       ('a@x','instance','r1','nota inst',NULL,NULL,NULL,'2026-10-01T00:00:00Z')`,
    ).run();
    const body = (await (await get('?from=2026-10-10&to=2026-10-10')).json()) as EventsResponse;
    expect(body.events[0]).toMatchObject({
      id: 'plain',
      notes: '',
      remind: false,
      remindDaysBefore: 5,
      color: '#1a73e8',
    });
    expect(body.events[1]).toMatchObject({
      id: 'r1',
      notes: 'nota inst',
      remind: true,
      remindDaysBefore: 10,
      color: '#00ff00',
      recurringEventId: 'ser',
    });
  });
});

describe('GET /api/today', () => {
  const at = (iso: string) => setClock(() => Date.parse(iso));
  const today = async () => (await (await call('/api/today', { ip })).json()) as TodayResponse;

  it('hoy y manana en Madrid, multi-dia en ambos', async () => {
    at('2026-10-23T10:00:00Z');
    await timed('a@x', 't', '2026-10-23T10:00:00.000Z', '2026-10-23T11:00:00.000Z');
    await timed('a@x', 'm', '2026-10-24T10:00:00.000Z', '2026-10-24T11:00:00.000Z');
    await timed('a@x', 'later', '2026-10-25T10:00:00.000Z', '2026-10-25T11:00:00.000Z');
    await allDay('a@x', 'both', '2026-10-23', '2026-10-25');
    const b = await today();
    expect([b.today, b.tomorrow]).toEqual(['2026-10-23', '2026-10-24']);
    expect(b.todayEvents.map((e) => e.id)).toEqual(['both', 't']);
    expect(b.tomorrowEvents.map((e) => e.id)).toEqual(['both', 'm']);
  });

  it('limite de medianoche Madrid (22:00Z en horario de verano)', async () => {
    await timed('a@x', 'last', '2026-10-23T21:59:00.000Z', '2026-10-23T21:59:30.000Z');
    await timed('a@x', 'first', '2026-10-23T22:00:00.000Z', '2026-10-23T22:30:00.000Z');
    at('2026-10-23T21:59:59Z'); // 23:59:59 en Madrid
    let b = await today();
    expect(b.today).toBe('2026-10-23');
    expect(b.todayEvents.map((e) => e.id)).toEqual(['last']);
    expect(b.tomorrowEvents.map((e) => e.id)).toEqual(['first']);
    at('2026-10-23T22:00:00Z'); // 00:00:00 del dia 24 en Madrid
    b = await today();
    expect(b.today).toBe('2026-10-24');
    expect(b.todayEvents.map((e) => e.id)).toEqual(['first']);
    expect(b.tomorrowEvents).toEqual([]);
  });

  it('aplica el filtro de calendarios', async () => {
    at('2026-10-23T10:00:00Z');
    await addCal('hidden@x', { enabled: 0 });
    await timed('hidden@x', 'h', '2026-10-23T10:00:00.000Z', '2026-10-23T11:00:00.000Z');
    expect((await today()).todayEvents).toEqual([]);
  });
});

describe('GET /api/events: ano valido', () => {
  it.each([
    ['?from=1969-12-31&to=1970-01-02'],
    ['?from=2099-12-30&to=2101-01-01'],
    ['?from=0000-01-01&to=0000-01-02'],
    ['?from=9999-12-30&to=9999-12-31'],
  ])('400 (no 500) con ano fuera de 1970..2100 %s', async (q) => {
    const res = await get(q);
    expect(res.status).toBe(400);
  });

  it('acepta los extremos 1970 y 2100', async () => {
    expect((await get('?from=1970-01-01&to=1970-01-02')).status).toBe(200);
    expect((await get('?from=2100-12-30&to=2100-12-31')).status).toBe(200);
  });
});

describe('GET /api/events/:calendarId/:eventId', () => {
  const one = (cal: string, id: string) =>
    call(`/api/events/${encodeURIComponent(cal)}/${encodeURIComponent(id)}`, { ip });

  it('401 sin token', async () => {
    expect((await call('/api/events/a%40x/e1', { ip, auth: null })).status).toBe(401);
  });

  it('devuelve el evento con la misma forma que la lista', async () => {
    await timed('a@x', 'e1', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    const res = await one('a@x', 'e1');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const ev = (await res.json()) as EventsResponse['events'][number];
    const list = (await (await get('?from=2026-10-10&to=2026-10-10')).json()) as EventsResponse;
    expect(ev).toEqual(list.events[0]);
    expect(ev).toMatchObject({ id: 'e1', calendarId: 'a@x', color: '#1a73e8' });
  });

  it('404 not_found si no existe, calendario oculto/eliminado, cancelado o borrado pendiente', async () => {
    await addCal('hidden@x', { enabled: 0 });
    await addCal('gone@x', { removed: '2026-10-01T00:00:00.000Z' });
    await timed('hidden@x', 'e1', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await timed('gone@x', 'e1', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await timed('a@x', 'canc', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await env.DB.prepare("UPDATE events SET status='cancelled' WHERE id='canc'").run();
    await timed('a@x', 'pdel', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await env.DB.prepare("UPDATE events SET pending_op='delete' WHERE id='pdel'").run();
    for (const [c, id] of [
      ['a@x', 'nope'],
      ['nope@x', 'e1'],
      ['hidden@x', 'e1'],
      ['gone@x', 'e1'],
      ['a@x', 'canc'],
      ['a@x', 'pdel'],
    ] as const) {
      const res = await one(c, id);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    }
  });

  it('respeta ids codificados en la URL (calendario con # y / y evento con espacios)', async () => {
    const cal = 'es.spain#holiday@group.v.calendar.google.com';
    await addCal(cal);
    await timed(
      cal,
      'ev/1 b_20261010T100000Z',
      '2026-10-10T10:00:00.000Z',
      '2026-10-10T11:00:00.000Z',
    );
    const res = await one(cal, 'ev/1 b_20261010T100000Z');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'ev/1 b_20261010T100000Z', calendarId: cal });
  });
});

describe('EventInfo: writable, frozen, pending', () => {
  const at = (iso: string) => setClock(() => Date.parse(iso));
  const list = async (q: string) => ((await (await get(q)).json()) as EventsResponse).events;
  const byId = (evs: EventsResponse['events']) => Object.fromEntries(evs.map((e) => [e.id, e]));

  it('writable segun access_role del calendario', async () => {
    await addCal('b@x');
    await addCal('c@x');
    await addCal('d@x');
    await env.DB.prepare(
      `UPDATE calendars SET access_role = CASE id WHEN 'a@x' THEN 'owner' WHEN 'b@x' THEN 'writer'
         WHEN 'c@x' THEN 'reader' ELSE NULL END`,
    ).run();
    for (const c of ['a@x', 'b@x', 'c@x', 'd@x']) {
      await timed(c, `e-${c}`, '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    }
    const m = byId(await list('?from=2026-10-10&to=2026-10-10'));
    expect([m['e-a@x']!.writable, m['e-b@x']!.writable]).toEqual([true, true]);
    expect([m['e-c@x']!.writable, m['e-d@x']!.writable]).toEqual([false, false]);
  });

  it('frozen: inicio anterior a hoy - 1 mes (Madrid), con y sin hora', async () => {
    at('2026-10-23T10:00:00Z'); // ventana: desde 2026-09-23 (timeMin 2026-09-22T22:00Z)
    await timed('a@x', 't-old', '2026-09-22T21:59:00.000Z', '2026-09-22T21:59:30.000Z');
    await timed('a@x', 't-edge', '2026-09-22T22:00:00.000Z', '2026-09-22T22:30:00.000Z');
    await allDay('a@x', 'd-old', '2026-09-22', '2026-09-23');
    await allDay('a@x', 'd-edge', '2026-09-23', '2026-09-24');
    const m = byId(await list('?from=2026-09-20&to=2026-09-25'));
    expect(m['t-old']!.frozen).toBe(true);
    expect(m['t-edge']!.frozen).toBe(false);
    expect(m['d-old']!.frozen).toBe(true);
    expect(m['d-edge']!.frozen).toBe(false);
  });

  it('pending: op y error desde pending_op/write_error; null si esta sincronizado', async () => {
    await timed('a@x', 'ok', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await timed('a@x', 'p1', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await timed('a@x', 'p2', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await env.DB.prepare("UPDATE events SET pending_op='patch' WHERE id='p1'").run();
    await env.DB.prepare(
      "UPDATE events SET pending_op='insert', write_error='conflict' WHERE id='p2'",
    ).run();
    const m = byId(await list('?from=2026-10-10&to=2026-10-10'));
    expect(m.ok!.pending).toBeNull();
    expect(m.p1!.pending).toEqual({ op: 'patch', error: null });
    expect(m.p2!.pending).toEqual({ op: 'insert', error: 'conflict' });
  });

  it('color efectivo: meta > (app: settings.app_events_color | calendario) > google', async () => {
    await env.DB.prepare('DELETE FROM settings').run();
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('app_events_color', '#123456', 'x')",
    ).run();
    await timed('a@x', 'g', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await timed('a@x', 'app', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await timed('a@x', 'app-meta', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    await env.DB.prepare("UPDATE events SET origin='app' WHERE id IN ('app','app-meta')").run();
    await env.DB.prepare(
      `INSERT INTO event_meta (calendar_id, scope, target_id, color, updated_at)
       VALUES ('a@x','instance','app-meta','#abcdef','2026-10-01T00:00:00Z')`,
    ).run();
    let m = byId(await list('?from=2026-10-10&to=2026-10-10'));
    expect(m.g!.color).toBe('#1a73e8');
    expect(m.app!.color).toBe('#123456');
    expect(m['app-meta']!.color).toBe('#abcdef');
    // Sin ajuste (o invalido): el evento de la app cae al color del calendario.
    await env.DB.prepare("UPDATE settings SET value='rojo'").run();
    m = byId(await list('?from=2026-10-10&to=2026-10-10'));
    expect(m.app!.color).toBe('#1a73e8');
    await env.DB.prepare('DELETE FROM settings').run();
    m = byId(await list('?from=2026-10-10&to=2026-10-10'));
    expect(m.app!.color).toBe('#1a73e8');
    // Sin color de calendario: color de Google.
    await env.DB.prepare('UPDATE calendars SET color = NULL').run();
    m = byId(await list('?from=2026-10-10&to=2026-10-10'));
    expect(m.app!.color).toBe('#9fe1e7');
  });
});

describe('cambios de hora (DST, Europe/Madrid)', () => {
  const at = (iso: string) => setClock(() => Date.parse(iso));
  const day = async (d: string) =>
    ids((await (await get(`?from=${d}&to=${d}`)).json()) as EventsResponse);
  const today = async () => (await (await call('/api/today', { ip })).json()) as TodayResponse;

  describe.each([
    {
      name: '2026-10-25 (dia de 25h)',
      d: '2026-10-25',
      prev: '2026-10-24',
      next: '2026-10-26',
      dayStart: '2026-10-24T22:00:00.000Z', // 00:00 CEST
      dayEnd: '2026-10-25T23:00:00.000Z', // 00:00 CET del dia siguiente
      late: ['2026-10-25T22:30:00.000Z', '2026-10-25T22:59:00.000Z'], // 23:30 CET
      nowIn: '2026-10-25T22:30:00Z',
      nowNext: '2026-10-25T23:00:00Z',
    },
    {
      name: '2026-03-29 (dia de 23h)',
      d: '2026-03-29',
      prev: '2026-03-28',
      next: '2026-03-30',
      dayStart: '2026-03-28T23:00:00.000Z', // 00:00 CET
      dayEnd: '2026-03-29T22:00:00.000Z', // 00:00 CEST del dia siguiente
      late: ['2026-03-29T21:30:00.000Z', '2026-03-29T21:59:00.000Z'], // 23:30 CEST
      nowIn: '2026-03-29T21:59:00Z',
      nowNext: '2026-03-29T22:00:00Z',
    },
  ])('$name', ({ d, prev, next, dayStart, dayEnd, late, nowIn, nowNext }) => {
    const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

    it('rango from/to: limites exactos del dia', async () => {
      await timed('a@x', 'before', plus(dayStart, -3_600_000), plus(dayStart, -1_000));
      await timed('a@x', 'first', dayStart, plus(dayStart, 1_800_000));
      await timed('a@x', 'last', late[1]!, plus(dayEnd, -1_000));
      await timed('a@x', 'after', dayEnd, plus(dayEnd, 1_800_000));
      expect(await day(prev)).toEqual(['before']);
      expect(await day(d)).toEqual(['first', 'last']);
      expect(await day(next)).toEqual(['after']);
      const all = (await (await get(`?from=${prev}&to=${next}`)).json()) as EventsResponse;
      expect(ids(all)).toEqual(['before', 'first', 'last', 'after']);
    });

    it('evento a las 23:30 locales cae en el dia y no en el siguiente', async () => {
      await timed('a@x', 'late', late[0]!, plus(late[0]!, 1_800_000));
      expect(await day(d)).toEqual(['late']);
      expect(await day(next)).toEqual([]);
    });

    it('evento de dia completo solo en su dia', async () => {
      await allDay('a@x', 'ad', d, next);
      expect(await day(prev)).toEqual([]);
      expect(await day(d)).toEqual(['ad']);
      expect(await day(next)).toEqual([]);
    });

    it('/api/today con now inyectado', async () => {
      await timed('a@x', 'late', late[0]!, plus(late[0]!, 1_800_000));
      await timed('a@x', 'nextday', dayEnd, plus(dayEnd, 1_800_000));
      await allDay('a@x', 'ad', d, next);
      at(nowIn); // 23:59 / 23:30 locales del dia
      let b = await today();
      expect([b.today, b.tomorrow]).toEqual([d, next]);
      expect(b.todayEvents.map((e) => e.id)).toEqual(['ad', 'late']);
      expect(b.tomorrowEvents.map((e) => e.id)).toEqual(['nextday']);
      at(nowNext); // 00:00 del dia siguiente
      b = await today();
      expect([b.today, b.tomorrow]).toEqual([next, addOne(next)]);
      expect(b.todayEvents.map((e) => e.id)).toEqual(['nextday']);
    });
  });

  it('/api/today usa c.env.TZ', async () => {
    // 2026-10-23T22:30Z: Madrid ya es dia 24 (00:30), America/New_York sigue en el 23.
    at('2026-10-23T22:30:00Z');
    expect((await today()).today).toBe('2026-10-24');
    const ny = await call('/api/today', { ip, env: { TZ: 'America/New_York' } });
    expect(((await ny.json()) as TodayResponse).today).toBe('2026-10-23');
    const dflt = await call('/api/today', { ip, env: { TZ: '' } }); // fallback Europe/Madrid
    expect(((await dflt.json()) as TodayResponse).today).toBe('2026-10-24');
  });
});

function addOne(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

describe('GET /api/calendars estado de sync', () => {
  it('expone lastSyncedAt y lastSyncError', async () => {
    await env.DB.prepare(
      "UPDATE calendars SET last_synced_at='2026-10-23T08:00:00.000Z', last_sync_error='forbidden'",
    ).run();
    await addCal('b@x');
    const res = await call('/api/calendars', { ip });
    const { calendars } = (await res.json()) as {
      calendars: { id: string; lastSyncedAt: string | null; lastSyncError: string | null }[];
    };
    const byId = Object.fromEntries(calendars.map((c) => [c.id, c]));
    expect(byId['a@x']).toMatchObject({
      lastSyncedAt: '2026-10-23T08:00:00.000Z',
      lastSyncError: 'forbidden',
    });
    expect(byId['b@x']).toMatchObject({ lastSyncedAt: null, lastSyncError: null });
  });
});
