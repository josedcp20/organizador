/// <reference types="vite/client" />
/**
 * Guardarrail T2.9 (escritura acotada, restriccion dura 2): nada privado sale hacia Google y solo
 * existe una puerta de salida (calendarApi.ts) con una sola fabrica de cuerpos (eventPayload.ts).
 * Se amplia en T3.6/T3.7/T3.9/T3.10 con las rutas nuevas.
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { isAllowedRequest } from '../src/google/calendarApi';
import { writeRuntime } from '../src/google/agendaWrites';
import { importCalendars } from '../src/google/calendarList';
import {
  eventIdFor,
  PAYLOAD_KEYS,
  toGooglePayload,
  type EventFields,
} from '../src/google/eventPayload';
import { deleteEvent, getEvent, insertEvent, patchEvent } from '../src/google/eventsWrite';
import { GOOGLE_SCOPES } from '../src/google/oauth';
import { runPendingWrites } from '../src/jobs/pendingWrites';
import { runSync } from '../src/sync/engine';
import { addCalendar, connect, FakeGoogle, fullEnv, NOW, OAUTH_ENV, resetDb } from './googleFake';
import { call } from './helpers';

const rnd = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const S = {
  note: `SENTINEL_NOTE_${rnd()}`,
  seriesNote: `SENTINEL_SERIES_${rnd()}`,
  detail: `SENTINEL_DETAIL_${rnd()}`,
  quick: `SENTINEL_QUICK_${rnd()}`,
  noteTitle: `SENTINEL_TITLE_${rnd()}`,
  flag: `SENTINEL_FLAG_${rnd()}`,
  // Colores centinela (calendario, evento, settings) y antelacion de aviso poco comun.
  calColor: '#c0ffee',
  eventColor: '#c0ff33',
  appColor: '#bada55',
  settingColor: '#facade',
};
const REMIND_DAYS = 37;
const SENTINEL_STRINGS = [
  S.note,
  S.seriesNote,
  S.detail,
  S.quick,
  S.noteTitle,
  S.flag,
  'c0ffee',
  'c0ff33',
  'bada55',
  'facade',
];
/** Claves privadas que nunca pueden aparecer en un cuerpo hacia Google. */
const FORBIDDEN_KEYS = [
  'notes',
  'remind',
  'remind_days_before',
  'color',
  'colorId',
  'attendees',
  'recurrence',
  'reminders',
  'quick',
  'details',
];

const CAL = 'pruebas@group.calendar.google.com';
const LOCAL = '6b1f0e2a-9c3d-4e5f-8a7b-0c1d2e3f4a5b';

let google: FakeGoogle;

/** Campos "sucios": lo que un caller descuidado podria pasar mezclando evento y meta privada. */
const dirty = (summary: string): EventFields =>
  ({
    summary,
    description: 'Descripcion publica',
    location: 'Sala 1',
    start: { allDay: false, dateTime: '2026-11-10T09:00:00Z' },
    end: { allDay: false, dateTime: '2026-11-10T10:00:00Z' },
    notes: S.note,
    privateNotes: S.note,
    details: S.detail,
    remind: true,
    remind_days_before: REMIND_DAYS,
    remindFlag: S.flag,
    color: S.eventColor,
    colorId: '11',
    quickNote: S.quick,
    attendees: [{ email: `${S.detail}@example.com` }],
    recurrence: ['RRULE:FREQ=DAILY'],
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: REMIND_DAYS }] },
    extendedProperties: { private: { notes: S.note }, shared: { color: S.eventColor } },
    meta: { notes: S.note, color: S.eventColor },
  }) as unknown as EventFields;

async function seedPrivateData(eventId: string) {
  const ts = '2026-10-20T00:00:00.000Z';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO event_meta (calendar_id, scope, target_id, notes, remind, remind_days_before, color, updated_at)
       VALUES (?1, 'instance', ?2, ?3, 1, ?4, ?5, ?6)`,
    ).bind(CAL, eventId, S.note, REMIND_DAYS, S.eventColor, ts),
    env.DB.prepare(
      `INSERT INTO event_meta (calendar_id, scope, target_id, notes, remind, remind_days_before, color, updated_at)
       VALUES (?1, 'series', 'serie1', ?2, 1, ?3, ?4, ?5)`,
    ).bind(CAL, S.seriesNote, REMIND_DAYS, S.eventColor, ts),
    env.DB.prepare(
      `INSERT INTO notes (id, body, title, kind, created_at, updated_at) VALUES ('n1', ?1, ?2, 'note', ?3, ?3)`,
    ).bind(S.detail, S.noteTitle, ts),
    env.DB.prepare(
      `INSERT INTO notes (id, body, kind, created_at, updated_at) VALUES ('q1', ?1, 'quick', ?2, ?2)`,
    ).bind(S.quick, ts),
    env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('app_events_color', ?1, ?2)`,
    ).bind(S.appColor, ts),
  ]);
}

function assertNoLeak() {
  const toGoogle = google.requests.filter((r) =>
    new URL(r.url).hostname.endsWith('googleapis.com'),
  );
  expect(toGoogle.length).toBeGreaterThan(0);
  for (const r of toGoogle) {
    const haystack = `${decodeURIComponent(r.url)}\n${JSON.stringify(r.headers)}\n${r.body ?? ''}`;
    for (const s of SENTINEL_STRINGS) expect(haystack.toLowerCase()).not.toContain(s.toLowerCase());
  }
}

function assertWriteBodies(localId: string) {
  const writes = google
    .calendarRequests()
    .filter((r) => r.method === 'POST' || r.method === 'PATCH' || r.method === 'DELETE');
  expect(writes.length).toBeGreaterThan(0);
  for (const r of writes) {
    expect(new URL(r.url).searchParams.get('sendUpdates')).toBe('none');
    if (r.method === 'DELETE') {
      expect(r.body).toBeNull();
      continue;
    }
    const body = JSON.parse(r.body!) as Record<string, unknown>;
    for (const k of Object.keys(body)) expect(PAYLOAD_KEYS).toContain(k);
    for (const k of FORBIDDEN_KEYS) expect(r.body!).not.toContain(`"${k}"`);
    // Ningun valor numerico (remind_days_before, minutos de recordatorio, colorId...).
    const numbers: unknown[] = [];
    JSON.parse(r.body!, (_k, v: unknown) => (typeof v === 'number' && numbers.push(v), v));
    expect(numbers).toEqual([]);
    if (r.method === 'POST') {
      expect(body.extendedProperties).toEqual({ private: { organizadorId: localId } });
    } else {
      expect(body.extendedProperties).toBeUndefined();
    }
  }
}

beforeEach(async () => {
  await resetDb();
  google = new FakeGoogle();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => google.handle(input, init)),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await connect();
  await addCalendar(CAL, 'owner', { color: S.calColor });
});

afterEach(() => {
  setClock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('T2.9 ejecucion: ningun dato privado sale hacia Google', () => {
  it('insert, reintento 409, patch, 412, delete, 410, get, sync completo e import', async () => {
    const id = await eventIdFor(LOCAL);
    await seedPrivateData(id);
    const e = fullEnv();
    const retry = { retry: { sleep: async () => {} } };

    const ins = await insertEvent(e, { calendarId: CAL, localId: LOCAL, fields: dirty('Cita') });
    expect(ins.created).toBe(true);
    // Reintento idempotente (409 duplicate -> events.get).
    expect(
      (await insertEvent(e, { calendarId: CAL, localId: LOCAL, fields: dirty('Cita') })).created,
    ).toBe(false);

    const etag = ins.event.etag!;
    const p = await patchEvent(
      e,
      { calendarId: CAL, eventId: id, etag, fields: dirty('Cita 2') },
      retry,
    );
    // etag viejo -> 412.
    await expect(
      patchEvent(e, { calendarId: CAL, eventId: id, etag, fields: dirty('Cita 3') }, retry),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await getEvent(e, CAL, id);
    // Sync completo (lectura) con el evento en Google y la meta privada en D1.
    await runSync(e, { nowMs: NOW });
    await deleteEvent(e, { calendarId: CAL, eventId: id, etag: p.event.etag! });
    await deleteEvent(e, { calendarId: CAL, eventId: id, etag: p.event.etag! }); // 410
    google.calendarList = [{ id: CAL, summary: 'Pruebas', accessRole: 'owner', selected: true }];
    await importCalendars(e);

    assertNoLeak();
    assertWriteBodies(LOCAL);
    // La meta privada sigue intacta en D1 (no se movio a Google ni se borro).
    const meta = await env.DB.prepare('SELECT COUNT(*) AS n FROM event_meta').first<{
      n: number;
    }>();
    expect(meta!.n).toBe(2);
    const cal = await env.DB.prepare('SELECT color FROM calendars WHERE id = ?1').bind(CAL).first();
    expect(cal).toEqual({ color: S.calColor });
  });

  it('toGooglePayload descarta las claves privadas aunque vengan en el objeto', () => {
    for (const mode of ['insert', 'patch'] as const) {
      const p = toGooglePayload(
        dirty('X'),
        mode,
        mode === 'insert' ? { id: 'abcdef12', organizadorId: LOCAL } : {},
      );
      const s = JSON.stringify(p);
      for (const k of Object.keys(p)) expect(PAYLOAD_KEYS).toContain(k);
      for (const x of SENTINEL_STRINGS) expect(s.toLowerCase()).not.toContain(x.toLowerCase());
      for (const k of FORBIDDEN_KEYS) expect(s).not.toContain(`"${k}"`);
    }
  });

  it('POST/PATCH/DELETE /api/agenda (T3.7) con meta centinela: nada privado llega a Google', async () => {
    writeRuntime.retry = { sleep: async () => {} };
    try {
      const id = await eventIdFor(LOCAL);
      await seedPrivateData(id);
      // Evento de Google con meta privada de instancia y de serie (centinelas).
      await env.DB.prepare(
        `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at, etag, updated, origin)
         VALUES (?1, 'g1', 'confirmed', 'De Google', 0, '2026-11-12T09:00:00.000Z', '2026-11-12T10:00:00.000Z', '"100"', '2026-10-01T00:00:00.000Z', 'google')`,
      )
        .bind(CAL)
        .run();
      google.put(CAL, {
        id: 'g1',
        status: 'confirmed',
        etag: '"100"',
        summary: 'De Google',
        start: { dateTime: '2026-11-12T09:00:00Z' },
        end: { dateTime: '2026-11-12T10:00:00Z' },
      });
      await env.DB.prepare(
        `INSERT INTO event_meta (calendar_id, scope, target_id, notes, remind, remind_days_before, color, updated_at)
         VALUES (?1, 'instance', 'g1', ?2, 1, ?3, ?4, '2026-10-20T00:00:00.000Z')`,
      )
        .bind(CAL, S.note, REMIND_DAYS, S.eventColor)
        .run();

      const send = (method: string, path: string, body?: unknown) =>
        call(path, {
          method,
          ip: '203.0.113.80',
          env: OAUTH_ENV,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const p = (e: string, q = '') => `/api/agenda/${encodeURIComponent(CAL)}/${e}${q}`;
      const base = {
        client_id: LOCAL,
        calendarId: CAL,
        summary: 'Cita',
        description: 'Descripcion publica',
        allDay: false,
        start: '2026-11-10T09:00:00Z',
        end: '2026-11-10T10:00:00Z',
      };
      // Colar meta privada en el alta/edicion se rechaza (400) sin red.
      expect((await send('POST', '/api/agenda', { ...base, notes: S.note })).status).toBe(400);
      expect((await send('PATCH', p(id), { color: S.eventColor })).status).toBe(400);
      expect(google.calendarRequests()).toHaveLength(0);

      expect((await send('POST', '/api/agenda', base)).status).toBe(201);
      expect((await send('POST', '/api/agenda', base)).status).toBe(200);
      expect((await send('PATCH', p(id), { summary: 'Cita 2', location: 'Sala' })).status).toBe(
        200,
      );
      // Patch de un evento de Google (confirmado) + conflicto 412 -> getEvent.
      expect((await send('PATCH', p('g1'), { summary: 'G2', confirm_external: true })).status).toBe(
        200,
      );
      google.put(CAL, { ...google.store.get(`${CAL}/g1`)!, etag: '"999"' });
      expect((await send('PATCH', p('g1'), { summary: 'G3', confirm_external: true })).status).toBe(
        409,
      );
      // Transitorio -> pendiente (payload en D1 sin meta).
      google.queue.push(new Error('net'), new Error('net'), new Error('net'));
      expect((await send('PATCH', p(id), { description: 'Otra publica' })).status).toBe(202);
      const pend = await env.DB.prepare('SELECT pending_payload FROM events WHERE id = ?1')
        .bind(id)
        .first<{ pending_payload: string }>();
      for (const s of SENTINEL_STRINGS) {
        expect(pend!.pending_payload.toLowerCase()).not.toContain(s.toLowerCase());
      }
      expect((await send('DELETE', p('g1', '?confirm_external=true'))).status).toBe(204);
      expect((await send('PATCH', p(id), { summary: 'Cita 3' })).status).toBe(200);
      expect((await send('DELETE', p(id))).status).toBe(204);

      assertNoLeak();
      assertWriteBodies(LOCAL);
      // Meta de serie intacta; la de instancia de los borrados, eliminada.
      const meta = await env.DB.prepare('SELECT scope, target_id FROM event_meta').all();
      expect(meta.results).toEqual([{ scope: 'series', target_id: 'serie1' }]);
    } finally {
      writeRuntime.retry = undefined;
    }
  });

  it('cola de pendientes (T3.10) con meta centinela y payload sucio: nada privado llega a Google', async () => {
    const id = await eventIdFor(LOCAL);
    await seedPrivateData(id);
    const later = NOW + 10 * 60_000;
    // Payloads pendientes "sucios" (como si un bug hubiera colado meta): toGooglePayload los filtra.
    const pending = (op: string, fields?: EventFields) =>
      JSON.stringify({ v: 1, writeId: `w-${op}`, op, fields });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at, origin,
           local_id, pending_op, pending_payload, pending_attempts, pending_since, write_error)
         VALUES (?1, ?2, 'confirmed', 'Cita', 0, '2026-11-10T09:00:00.000Z', '2026-11-10T10:00:00.000Z',
           'app', ?3, 'insert', ?4, 1, ?5, 'transient')`,
      ).bind(CAL, id, LOCAL, pending('insert', dirty('Cita')), new Date(NOW).toISOString()),
      ...['g1', 'g2'].map((g, i) =>
        env.DB.prepare(
          `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at, etag,
             updated, origin, pending_op, pending_payload, pending_attempts, pending_since, write_error)
           VALUES (?1, ?2, 'confirmed', 'De Google', 0, '2026-11-12T09:00:00.000Z',
             '2026-11-12T10:00:00.000Z', '"100"', '2026-10-01T00:00:00.000Z', 'google', ?3, ?4, 1, ?5,
             'transient')`,
        ).bind(
          CAL,
          g,
          i ? 'delete' : 'patch',
          i ? pending('delete') : pending('patch', dirty('G2')),
          new Date(NOW).toISOString(),
        ),
      ),
    ]);
    for (const g of ['g1', 'g2']) {
      google.put(CAL, {
        id: g,
        status: 'confirmed',
        etag: '"100"',
        summary: 'De Google',
        start: { dateTime: '2026-11-12T09:00:00Z' },
        end: { dateTime: '2026-11-12T10:00:00Z' },
      });
    }
    setClock(() => later);
    const r = await runPendingWrites(fullEnv(), { nowMs: later });
    expect(r.counts.done).toBe(3);
    assertNoLeak();
    assertWriteBodies(LOCAL);
  });

  it('GET/PATCH /api/settings no emiten ninguna peticion a Google', async () => {
    const send = (method: string, body?: unknown) =>
      call('/api/settings', {
        method,
        ip: '203.0.113.81',
        env: OAUTH_ENV,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect(
      (await send('PATCH', { app_events_color: S.settingColor, default_write_calendar: CAL }))
        .status,
    ).toBe(200);
    expect((await send('PATCH', { app_events_color: null })).status).toBe(200);
    expect((await send('GET')).status).toBe(200);
    expect(google.requests).toHaveLength(0);
  });

  it('PATCH /api/calendars (color propio) no emite ninguna peticion a Google', async () => {
    const res = await call(`/api/calendars/${encodeURIComponent(CAL)}`, {
      method: 'PATCH',
      ip: '203.0.113.77',
      env: OAUTH_ENV,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: S.settingColor, visible: false }),
    });
    expect(res.status).toBe(200);
    expect(google.requests).toHaveLength(0);
  });

  it('PUT/DELETE /api/agenda/.../meta (instancia y serie) no emiten ninguna peticion a Google', async () => {
    await env.DB.prepare(
      `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at, recurring_event_id, origin)
       VALUES (?1, 'inst1', 'confirmed', 'Serie', 0, '2026-11-10T09:00:00.000Z', '2026-11-10T10:00:00.000Z', 'serie1', 'google')`,
    )
      .bind(CAL)
      .run();
    const url = `/api/agenda/${encodeURIComponent(CAL)}/inst1/meta`;
    const send = (method: string, body?: unknown, q = '') =>
      call(`${url}${q}`, {
        method,
        ip: '203.0.113.78',
        env: OAUTH_ENV,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    for (const scope of ['instance', 'series'] as const) {
      const res = await send('PUT', {
        scope,
        notes: scope === 'series' ? S.seriesNote : S.note,
        remind: true,
        remind_days_before: REMIND_DAYS,
        color: S.eventColor,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ remindDaysBefore: REMIND_DAYS, notes: S.note });
    }
    // Intentar colar campos de Google (description) junto a la meta se rechaza.
    expect((await send('PUT', { scope: 'instance', description: S.detail })).status).toBe(400);
    for (const scope of ['instance', 'series']) {
      expect((await send('DELETE', undefined, `?scope=${scope}`)).status).toBe(200);
    }
    expect(google.requests).toHaveLength(0);
    const ev = await env.DB.prepare(`SELECT description FROM events WHERE id = 'inst1'`).first();
    expect(ev).toEqual({ description: null });
  });

  it('/api/notes y /api/quick-notes (POST/PATCH/DELETE y listados) no emiten peticiones a Google', async () => {
    const send = (path: string, method: string, body?: string, ctype?: string) =>
      call(path, {
        method,
        ip: '203.0.113.79',
        env: OAUTH_ENV,
        headers: ctype ? { 'Content-Type': ctype } : {},
        body,
      });
    const json = 'application/json';
    const created = await send(
      '/api/notes',
      'POST',
      JSON.stringify({ title: S.noteTitle, body: S.note }),
      json,
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(
      (await send(`/api/notes/${id}`, 'PATCH', JSON.stringify({ body: S.detail }), json)).status,
    ).toBe(200);

    const qj = await send('/api/quick-notes', 'POST', JSON.stringify({ body: S.quick }), json);
    expect(qj.status).toBe(201);
    const qt = await send('/api/quick-notes', 'POST', S.quick, 'text/plain');
    expect(qt.status).toBe(201);
    const qid = ((await qj.json()) as { id: string }).id;

    expect((await send('/api/notes', 'GET')).status).toBe(200);
    expect((await send('/api/quick-notes', 'GET')).status).toBe(200);
    expect((await send(`/api/quick-notes/${qid}`, 'DELETE')).status).toBe(204);
    expect((await send(`/api/notes/${id}`, 'DELETE')).status).toBe(204);

    expect(google.requests.length).toBe(0);
  });
});

describe('T2.9 estatico: una sola puerta de salida', () => {
  const files = import.meta.glob('../src/**/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const API = '../src/google/calendarApi.ts';
  const others = () => Object.entries(files).filter(([f]) => f !== API);

  it('solo calendarApi.ts contiene googleapis.com/calendar o calendar/v3', () => {
    expect(Object.keys(files).length).toBeGreaterThan(10);
    for (const needle of ['googleapis.com/' + 'calendar', 'calendar' + '/v3']) {
      const offenders = Object.entries(files)
        .filter(([, src]) => src.includes(needle))
        .map(([f]) => f);
      expect(offenders).toEqual([API]);
    }
  });

  it('calendarApi.ts no contiene PUT, move, quickAdd, import, acl', () => {
    const src = files[API]!;
    for (const bad of ['PUT', '/move', '/quickAdd', '/import', '/acl', 'sendUpdates=all']) {
      expect(src).not.toContain(bad);
    }
  });

  it('la allowlist de calendarList es solo GET', () => {
    for (const m of ['POST', 'PATCH', 'DELETE'] as const) {
      expect(isAllowedRequest(m, 'users/me/calendarList')).toBe(false);
    }
  });

  it('fuera de calendarApi.ts nadie llama a googleRequest con un metodo de escritura', () => {
    const offenders = others()
      .filter(([, src]) => /googleRequest\(\s*['"`](?!GET['"`])/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('solo eventsWrite.ts usa las peticiones de escritura de calendarApi', () => {
    const offenders = others()
      .filter(([, src]) => /\b(insert|patch|delete)EventRequest\b/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual(['../src/google/eventsWrite.ts']);
  });

  it('solo eventPayload.ts construye cuerpos (extendedProperties) para Google', () => {
    const offenders = Object.entries(files)
      .filter(([, src]) => /extendedProperties\s*[:=]\s*\{/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual(['../src/google/eventPayload.ts']);
  });

  it('GOOGLE_SCOPES nunca incluye el scope completo auth/calendar', () => {
    expect(GOOGLE_SCOPES).not.toContain('https://www.googleapis.com/auth/calendar');
    expect(GOOGLE_SCOPES.every((s) => s !== 'https://www.googleapis.com/auth/calendar')).toBe(true);
  });
});
