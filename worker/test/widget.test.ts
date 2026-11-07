import type { WidgetTodayResponse } from '@organizador/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setClock } from '../src/clock';
import { call } from './helpers';

const ip = '203.0.113.51';
const CAL = 'a@x';
const get = () => call('/api/widget/today', { ip });
const at = (iso: string) => setClock(() => Date.parse(iso));
const json = async () => (await get()).json<WidgetTodayResponse>();

async function timed(id: string, start: string, o: { title?: string; end?: string } = {}) {
  const end = o.end ?? new Date(Date.parse(start) + 3_600_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO events (calendar_id, id, status, summary, description, location, all_day, start_at, end_at, origin)
     VALUES (?1, ?2, 'confirmed', ?3, 'SECRET_DESC', 'SECRET_LOC', 0, ?4, ?5, 'google')`,
  )
    .bind(CAL, id, o.title ?? id, start, end)
    .run();
}

async function allDay(id: string, date: string, remind = false) {
  await env.DB.prepare(
    `INSERT INTO events (calendar_id, id, status, summary, all_day, start_date, end_date, origin)
     VALUES (?1, ?2, 'confirmed', ?2, 1, ?3, ?4, 'google')`,
  )
    .bind(CAL, id, date, new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10))
    .run();
  if (remind) {
    await env.DB.prepare(
      `INSERT INTO event_meta (calendar_id, scope, target_id, remind, notes, updated_at)
       VALUES (?1, 'instance', ?2, 1, 'SECRET_NOTES', '2026-10-01T00:00:00Z')`,
    )
      .bind(CAL, id)
      .run();
  }
}

beforeEach(async () => {
  for (const t of ['event_done', 'event_meta', 'events', 'calendars']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare(
    `INSERT INTO calendars (id, summary, google_color, color, enabled) VALUES (?1, ?1, '#9fe1e7', '#1a73e8', 1)`,
  )
    .bind(CAL)
    .run();
  at('2026-10-27T10:00:00Z'); // 11:00 Madrid (CET)
});
afterEach(() => setClock());

describe('GET /api/widget/today', () => {
  it('401 sin token', async () => {
    expect((await call('/api/widget/today', { ip, auth: null })).status).toBe(401);
  });

  it('dia vacio: forma exacta, no-store y refreshAt = ahora + 15 min', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    const b = await r.json<WidgetTodayResponse>();
    expect(Object.keys(b)).toEqual([
      'v',
      'generatedAt',
      'date',
      'refreshAt',
      'today',
      'todayTotal',
      'todayDone',
      'next',
      'tomorrow',
      'reminders',
    ]);
    expect(b).toMatchObject({
      v: 1,
      date: '2026-10-27',
      generatedAt: '2026-10-27T10:00:00.000Z',
      refreshAt: '2026-10-27T10:15:00.000Z',
      today: [],
      todayTotal: 0,
      todayDone: 0,
      next: null,
      tomorrow: { total: 0, first: null },
      reminders: [],
    });
  });

  it('eventos: hora Madrid, done, next salta hechos/terminados/dia completo; sin campos privados', async () => {
    await allDay('ad', '2026-10-27');
    await timed('past', '2026-10-27T07:00:00Z'); // acabo 08:00Z
    await timed('done', '2026-10-27T11:00:00Z');
    await timed('mid', '2026-10-27T09:30:00Z', { title: '  Dentista \n  largo ' }); // en curso
    await timed('later', '2026-10-27T15:00:00Z');
    await env.DB.prepare(`INSERT INTO event_done VALUES (?1, 'done', '2026-10-27T09:00:00Z')`)
      .bind(CAL)
      .run();
    await timed('tom', '2026-10-28T08:00:00Z');
    const raw = await (await get()).text();
    expect(raw).not.toMatch(/SECRET_|a@x/);
    const b = JSON.parse(raw) as WidgetTodayResponse;
    expect(b.todayTotal).toBe(5);
    expect(b.todayDone).toBe(1);
    expect(b.today.find((e) => e.title === 'done')).toEqual({
      time: '12:00',
      title: 'done',
      done: true,
      startAt: '2026-10-27T11:00:00Z',
    });
    expect(b.today[0]).toEqual({ time: null, title: 'ad', done: false, startAt: null });
    expect(Object.keys(b.today[1]!)).toEqual(['time', 'title', 'done', 'startAt']);
    expect(b.next).toMatchObject({ time: '10:30', title: 'Dentista largo' });
    expect(b.tomorrow).toEqual({
      total: 1,
      first: { time: '09:00', title: 'tom', done: false, startAt: '2026-10-28T08:00:00Z' },
    });
  });

  it('next null si no queda ninguno', async () => {
    await timed('past', '2026-10-27T07:00:00Z');
    expect((await json()).next).toBeNull();
  });

  it('refreshAt = inicio del siguiente evento si es antes de 15 min', async () => {
    await timed('soon', '2026-10-27T10:05:00Z');
    expect((await json()).refreshAt).toBe('2026-10-27T10:05:00.000Z');
  });

  it('refreshAt = fin del evento en curso', async () => {
    await timed('now', '2026-10-27T09:30:00Z', { end: '2026-10-27T10:10:00Z' });
    expect((await json()).refreshAt).toBe('2026-10-27T10:10:00.000Z');
  });

  it('refreshAt = medianoche Madrid (23:55 local) y en dia de cambio de hora', async () => {
    at('2026-10-27T22:55:00Z'); // 23:55 CET
    expect((await json()).refreshAt).toBe('2026-10-27T23:00:00.000Z');
    at('2026-10-24T21:55:00Z'); // 23:55 CEST; el 25 tiene 25 h, medianoche = 22:00Z
    expect((await json()).refreshAt).toBe('2026-10-24T22:00:00.000Z');
  });

  it('refreshAt nunca <= ahora aunque un evento empiece ya', async () => {
    await timed('x', '2026-10-27T10:00:30Z');
    expect((await json()).refreshAt).toBe('2026-10-27T10:01:00.000Z');
  });

  it('limites: 8 en today, titulos <= 40, avisos <= 2 y respuesta < 2 KB', async () => {
    for (let i = 0; i < 12; i++) {
      await timed(`e${i}`, `2026-10-27T${String(11 + (i % 10)).padStart(2, '0')}:00:00Z`, {
        title: 'Ñandú ñoño '.repeat(8),
      });
    }
    await timed('t', '2026-10-28T08:00:00Z', { title: 'ó'.repeat(100) });
    for (const d of ['28', '29', '30']) await allDay(`r${d}`, `2026-10-${d}`, true);
    const raw = await (await get()).text();
    const b = JSON.parse(raw) as WidgetTodayResponse;
    expect(b.today).toHaveLength(8);
    expect(b.todayTotal).toBe(12);
    expect(b.today.every((e) => e.title.length <= 40)).toBe(true);
    expect(b.tomorrow.first!.title.length).toBeLessThanOrEqual(40);
    expect(b.reminders).toHaveLength(2);
    expect(b.reminders[0]!.inDays).toBe(1);
    expect(new TextEncoder().encode(raw).length).toBeLessThan(2048);
  });
});
