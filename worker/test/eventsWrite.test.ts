import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import {
  deleteEventRequest,
  eventPath,
  googleRequest,
  insertEventRequest,
  isAllowedRequest,
  patchEventRequest,
} from '../src/google/calendarApi';
import {
  eventIdFor,
  isGooglePayload,
  PayloadError,
  toBase32Hex,
  toGooglePayload,
  type EventFields,
  type GooglePayload,
} from '../src/google/eventPayload';
import { deleteEvent, getEvent, insertEvent, patchEvent } from '../src/google/eventsWrite';
import { GoogleAuthError } from '../src/google/oauth';
import {
  classifyWriteError,
  GoogleWriteError,
  retryDelayMs,
  withRetries,
} from '../src/google/writeErrors';
import { GoogleApiError } from '../src/google/calendarApi';
import { runSync } from '../src/sync/engine';
import {
  addCalendar,
  connect,
  FakeGoogle,
  fullEnv,
  gError,
  json,
  NOW,
  resetDb,
} from './googleFake';

let google: FakeGoogle;
const sleeps: number[] = [];
const noSleep = { retry: { sleep: async (ms: number) => void sleeps.push(ms), rand: () => 0.5 } };

const CAL = 'pruebas@group.calendar.google.com';
const READER = 'compartido@gmail.com';
const LOCAL = '0d9c2b1e-4f6a-4c1b-9a3e-1234567890ab';

const timed: EventFields = {
  summary: 'Dentista',
  location: 'Calle Mayor 1',
  description: 'Descripcion publica',
  start: { allDay: false, dateTime: '2026-11-02T09:00:00Z' },
  end: { allDay: false, dateTime: '2026-11-02T10:00:00Z' },
};

type Row = Record<string, unknown>;
const row = (cal: string, id: string) =>
  env.DB.prepare('SELECT * FROM events WHERE calendar_id = ?1 AND id = ?2')
    .bind(cal, id)
    .first<Row>();

async function seedEvent(cal: string, id: string, extra: Row = {}) {
  const r: Row = {
    status: 'confirmed',
    summary: 'Antes',
    all_day: 0,
    start_at: '2026-11-05T09:00:00.000Z',
    end_at: '2026-11-05T10:00:00.000Z',
    etag: '"100"',
    updated: '2026-10-01T00:00:00.000Z',
    origin: 'google',
    pending_op: null,
    ...extra,
  };
  const cols = Object.keys(r);
  await env.DB.prepare(
    `INSERT INTO events (calendar_id, id, ${cols.join(', ')})
     VALUES (?1, ?2, ${cols.map((_, i) => `?${i + 3}`).join(', ')})`,
  )
    .bind(cal, id, ...cols.map((c) => r[c]))
    .run();
}

const googleEvent = (id: string, extra: Row = {}): Row => ({
  id,
  status: 'confirmed',
  etag: '"100"',
  updated: '2026-10-01T00:00:00.000Z',
  summary: 'Antes',
  start: { dateTime: '2026-11-05T09:00:00Z' },
  end: { dateTime: '2026-11-05T10:00:00Z' },
  ...extra,
});

const calls = () => google.calendarRequests();
const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('se esperaba un error');
};

beforeEach(async () => {
  await resetDb();
  google = new FakeGoogle();
  sleeps.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => google.handle(input, init)),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await connect();
  await addCalendar(CAL, 'owner');
  await addCalendar(READER, 'reader');
});

afterEach(() => {
  setClock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe('toGooglePayload', () => {
  it('insert con hora: dateTime UTC + timeZone Europe/Madrid, id y marca de la app', () => {
    const p = toGooglePayload(timed, 'insert', { id: 'abc12345', organizadorId: LOCAL });
    expect(p).toEqual({
      id: 'abc12345',
      summary: 'Dentista',
      location: 'Calle Mayor 1',
      description: 'Descripcion publica',
      start: { dateTime: '2026-11-02T09:00:00.000Z', timeZone: 'Europe/Madrid' },
      end: { dateTime: '2026-11-02T10:00:00.000Z', timeZone: 'Europe/Madrid' },
      extendedProperties: { private: { organizadorId: LOCAL } },
    });
  });

  it('dia completo usa start.date/end.date (fin exclusivo)', () => {
    const p = toGooglePayload(
      {
        summary: 'Viaje',
        start: { allDay: true, date: '2026-11-02' },
        end: { allDay: true, date: '2026-11-04' },
      },
      'insert',
      { id: 'abc12345', organizadorId: LOCAL },
    );
    expect(p.start).toEqual({ date: '2026-11-02' });
    expect(p.end).toEqual({ date: '2026-11-04' });
  });

  it('descarta cualquier clave fuera de la lista blanca aunque venga en el objeto', () => {
    const dirty = {
      ...timed,
      notes: 'N',
      privateNotes: 'N',
      remind: true,
      remind_days_before: 37,
      color: '#c0ffee',
      colorId: '5',
      attendees: [{ email: 'x@y' }],
      recurrence: ['RRULE:FREQ=DAILY'],
      reminders: { useDefault: false },
      extendedProperties: { private: { notes: 'N' } },
      id: 'otroid99',
      visibility: 'public',
    } as unknown as EventFields;
    const p = toGooglePayload(dirty, 'insert', { id: 'abc12345', organizadorId: LOCAL });
    expect(Object.keys(p).sort()).toEqual(
      ['description', 'end', 'extendedProperties', 'id', 'location', 'start', 'summary'].sort(),
    );
    expect(p.id).toBe('abc12345');
    expect(p.extendedProperties).toEqual({ private: { organizadorId: LOCAL } });
    const patch = toGooglePayload(dirty, 'patch');
    expect(Object.keys(patch).sort()).toEqual([
      'description',
      'end',
      'location',
      'start',
      'summary',
    ]);
  });

  it('patch: solo lo presente; null vacia el campo; nunca id ni marca', () => {
    expect(toGooglePayload({ summary: 'X' }, 'patch')).toEqual({ summary: 'X' });
    expect(toGooglePayload({ location: null, description: '' }, 'patch')).toEqual({
      location: '',
      description: '',
    });
    expect(() => toGooglePayload({ summary: 'X' }, 'patch', { id: 'abc12345' })).toThrow(
      PayloadError,
    );
  });

  it('insert omite textos vacios o null', () => {
    const p = toGooglePayload({ ...timed, location: null, description: '' }, 'insert', {
      id: 'abc12345',
      organizadorId: LOCAL,
    });
    expect('location' in p).toBe(false);
    expect('description' in p).toBe(false);
  });

  it.each<[string, EventFields, 'insert' | 'patch']>([
    ['patch vacio', {}, 'patch'],
    ['insert sin fechas', { summary: 'x' }, 'insert'],
    ['start sin end', { start: timed.start }, 'patch'],
    ['end sin start', { end: timed.end }, 'patch'],
    ['tipos mezclados', { start: timed.start, end: { allDay: true, date: '2026-11-03' } }, 'patch'],
    ['fin antes del inicio', { start: timed.end, end: timed.start }, 'patch'],
    [
      'dia completo con fin igual al inicio',
      { start: { allDay: true, date: '2026-11-02' }, end: { allDay: true, date: '2026-11-02' } },
      'patch',
    ],
    [
      'fecha imposible',
      { start: { allDay: true, date: '2026-02-30' }, end: { allDay: true, date: '2026-03-02' } },
      'patch',
    ],
    [
      'dateTime invalido',
      { start: { allDay: false, dateTime: 'manana' }, end: timed.end },
      'patch',
    ],
    ['summary demasiado largo', { summary: 'x'.repeat(1025) }, 'patch'],
    ['summary no string', { summary: 5 as unknown as string }, 'patch'],
  ])('rechaza %s', (_n, fields, mode) => {
    expect(() =>
      toGooglePayload(
        fields,
        mode,
        mode === 'insert' ? { id: 'abc12345', organizadorId: LOCAL } : {},
      ),
    ).toThrow(PayloadError);
  });

  it('insert exige id base32hex y organizadorId valido', () => {
    expect(() =>
      toGooglePayload(timed, 'insert', { id: 'ABC12345', organizadorId: LOCAL }),
    ).toThrow();
    expect(() =>
      toGooglePayload(timed, 'insert', { id: 'abcwxyz9', organizadorId: LOCAL }),
    ).toThrow();
    expect(() =>
      toGooglePayload(timed, 'insert', { id: 'abc12345', organizadorId: 'a b' }),
    ).toThrow();
    expect(() => toGooglePayload(timed, 'insert', { id: 'abc12345' })).toThrow();
  });

  it('el resultado esta congelado y registrado; una copia no cuenta como payload', () => {
    const p = toGooglePayload(timed, 'patch');
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.start)).toBe(true);
    expect(isGooglePayload(p)).toBe(true);
    expect(isGooglePayload({ ...p })).toBe(false);
    expect(isGooglePayload(JSON.parse(JSON.stringify(p)))).toBe(false);
  });
});

describe('ids base32hex', () => {
  it('toBase32Hex sigue RFC 4648 (base32hex, minusculas, sin relleno)', () => {
    const enc = (s: string) => toBase32Hex(new TextEncoder().encode(s));
    expect(enc('f')).toBe('co');
    expect(enc('fooba')).toBe('cpnmuoj1');
    expect(enc('foobar')).toBe('cpnmuoj1e8');
  });

  it('eventIdFor es determinista, 32 chars base32hex y distinto por organizadorId', async () => {
    const a = await eventIdFor(LOCAL);
    expect(a).toMatch(/^[0-9a-v]{32}$/);
    expect(await eventIdFor(LOCAL)).toBe(a);
    expect(await eventIdFor('otro-id')).not.toBe(a);
    await expect(eventIdFor('no valido!')).rejects.toThrow(PayloadError);
  });
});

describe('googleRequest: escrituras', () => {
  const payload = () => toGooglePayload({ summary: 'X' }, 'patch');

  it('allowlist: insert/patch/delete/get de UN evento con segmentos codificados', () => {
    expect(isAllowedRequest('POST', 'calendars/primary/events')).toBe(true);
    expect(isAllowedRequest('PATCH', eventPath('a/b@x', 'e_1'))).toBe(true);
    expect(eventPath('a@x', '../x')).toBe('calendars/a%40x/events/..%2Fx');
    expect(isAllowedRequest('GET', eventPath('a@x', 'e1'))).toBe(true);
    expect(isAllowedRequest('GET', eventPath('a@x', 'abc123_20261010T100000Z'))).toBe(true);
    expect(isAllowedRequest('PATCH', 'calendars/a@x/events/..')).toBe(false);
  });

  it('eventId limitado a [A-Za-z0-9_-]: el path traversal no sale a la red', async () => {
    for (const bad of ['../x', '..', 'a.b', 'a b', 'a@b', 'a%2Fb', 'a/b']) {
      expect(isAllowedRequest('DELETE', eventPath('a@x', bad))).toBe(false);
    }
    await expect(deleteEventRequest('t', 'a@x', '../../../oauth2', '"1"')).rejects.toThrow(
      /not_allowed/,
    );
    expect(calls()).toHaveLength(0);
  });

  it('PATCH rechaza un cuerpo de insert (id/extendedProperties) y POST uno de patch', async () => {
    const ins = toGooglePayload(timed, 'insert', { id: 'abc12345', organizadorId: LOCAL });
    await expect(patchEventRequest('t', 'a@x', 'e1', '"1"', ins)).rejects.toThrow(/not_allowed/);
    await expect(insertEventRequest('t', 'a@x', payload())).rejects.toThrow(/not_allowed/);
    expect(calls()).toHaveLength(0);
  });

  it('el fetch no sigue redirecciones', async () => {
    google.queue.push(json({ id: 'e1' }));
    await patchEventRequest('t', 'a@x', 'e1', '"1"', payload());
    const init = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(init?.redirect).toBe('error');
  });

  it('POST/PATCH rechazan cuerpos que no salen de toGooglePayload, sin red', async () => {
    const raw = { summary: 'X', notes: 'secreto' } as unknown as GooglePayload;
    await expect(insertEventRequest('t', 'a@x', raw)).rejects.toThrow(/not_allowed/);
    await expect(patchEventRequest('t', 'a@x', 'e1', '"1"', raw)).rejects.toThrow(/not_allowed/);
    await expect(
      patchEventRequest('t', 'a@x', 'e1', '"1"', { ...payload() } as GooglePayload),
    ).rejects.toThrow(/not_allowed/);
    expect(calls()).toHaveLength(0);
  });

  it('PATCH/DELETE exigen If-Match valido; POST/GET no lo admiten', async () => {
    await expect(
      googleRequest('PATCH', 'calendars/a/events/e1', { token: 't', body: payload() }),
    ).rejects.toThrow(/not_allowed/);
    await expect(googleRequest('DELETE', 'calendars/a/events/e1', { token: 't' })).rejects.toThrow(
      /not_allowed/,
    );
    await expect(deleteEventRequest('t', 'a', 'e1', '"1"\r\nX-Evil: 1')).rejects.toThrow(
      /not_allowed/,
    );
    await expect(deleteEventRequest('t', 'a', 'e1', '')).rejects.toThrow(/not_allowed/);
    const ins = toGooglePayload(timed, 'insert', { id: 'abc12345', organizadorId: LOCAL });
    await expect(
      googleRequest('POST', 'calendars/a/events', { token: 't', body: ins, ifMatch: '"1"' }),
    ).rejects.toThrow(/not_allowed/);
    await expect(
      googleRequest('GET', 'calendars/a/events', { token: 't', ifMatch: '"1"' }),
    ).rejects.toThrow(/not_allowed/);
    expect(calls()).toHaveLength(0);
  });

  it('DELETE no admite cuerpo y GET tampoco; las escrituras no admiten query', async () => {
    await expect(
      googleRequest('DELETE', 'calendars/a/events/e1', {
        token: 't',
        body: payload(),
        ifMatch: '"1"',
      }),
    ).rejects.toThrow(/not_allowed/);
    await expect(
      googleRequest('GET', 'calendars/a/events', { token: 't', body: payload() }),
    ).rejects.toThrow(/not_allowed/);
    await expect(
      googleRequest('PATCH', 'calendars/a/events/e1', {
        token: 't',
        body: payload(),
        ifMatch: '"1"',
        query: { sendUpdates: 'all' },
      }),
    ).rejects.toThrow(/not_allowed/);
    expect(calls()).toHaveLength(0);
  });

  it('siempre sendUpdates=none, If-Match en patch/delete, JSON solo en POST/PATCH; 204 -> null', async () => {
    google.queue.push(
      json({ id: 'abc12345' }),
      json({ id: 'e1' }),
      new Response(null, { status: 204 }),
    );
    const ins = toGooglePayload(timed, 'insert', { id: 'abc12345', organizadorId: LOCAL });
    await insertEventRequest('t', 'a@x', ins);
    await patchEventRequest('t', 'a@x', 'e1', '"7"', payload());
    await expect(deleteEventRequest('t', 'a@x', 'e1', '"8"')).resolves.toBeNull();
    const [i, p, d] = calls();
    for (const r of [i!, p!, d!]) {
      const u = new URL(r.url);
      expect([...u.searchParams.entries()]).toEqual([['sendUpdates', 'none']]);
    }
    expect(i!.method).toBe('POST');
    expect(i!.headers['if-match']).toBeUndefined();
    expect(i!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(i!.body!)).toEqual(ins);
    expect(p!.method).toBe('PATCH');
    expect(p!.headers['if-match']).toBe('"7"');
    expect(JSON.parse(p!.body!)).toEqual({ summary: 'X' });
    expect(d!.method).toBe('DELETE');
    expect(d!.headers['if-match']).toBe('"8"');
    expect(d!.body).toBeNull();
    expect(d!.headers['content-type']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe('insertEvent', () => {
  it('crea con id determinista, guarda en D1 (origin app, etag/updated del body) y limpia pending', async () => {
    const id = await eventIdFor(LOCAL);
    // Fila optimista previa de la ruta (T3.7) con pending_op='insert'.
    await seedEvent(CAL, id, {
      pending_op: 'insert',
      pending_since: '2026-10-23T09:59:00.000Z',
      pending_attempts: 1,
      write_error: 'transient',
      etag: null,
      updated: null,
      origin: 'app',
      local_id: LOCAL,
    });
    const res = await insertEvent(fullEnv(), { calendarId: CAL, localId: LOCAL, fields: timed });
    expect(res.created).toBe(true);
    expect(res.event.id).toBe(id);
    const [r] = calls();
    expect(r!.method).toBe('POST');
    expect(r!.url).toBe(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events?sendUpdates=none`,
    );
    const sent = JSON.parse(r!.body!) as Row;
    expect(sent.id).toBe(id);
    expect(sent.extendedProperties).toEqual({ private: { organizadorId: LOCAL } });

    const db = (await row(CAL, id))!;
    const stored = google.store.get(`${CAL}/${id}`)!;
    expect(db).toMatchObject({
      origin: 'app',
      local_id: LOCAL,
      summary: 'Dentista',
      location: 'Calle Mayor 1',
      description: 'Descripcion publica',
      all_day: 0,
      start_at: '2026-11-02T09:00:00.000Z',
      end_at: '2026-11-02T10:00:00.000Z',
      etag: stored.etag,
      updated: new Date(NOW).toISOString(),
      pending_op: null,
      pending_payload: null,
      pending_since: null,
      pending_attempts: 0,
      write_error: null,
    });
    expect(db.etag).not.toMatch(/header/);
  });

  it('sin fila previa tambien inserta la fila', async () => {
    const res = await insertEvent(fullEnv(), {
      calendarId: CAL,
      localId: LOCAL,
      fields: {
        summary: 'Dia',
        start: { allDay: true, date: '2026-12-01' },
        end: { allDay: true, date: '2026-12-02' },
      },
    });
    expect(await row(CAL, res.event.id)).toMatchObject({
      all_day: 1,
      start_date: '2026-12-01',
      end_date: '2026-12-02',
      origin: 'app',
    });
  });

  it('409 duplicate = idempotente: lee el evento existente (si es nuestro) y no duplica', async () => {
    const id = await eventIdFor(LOCAL);
    google.put(CAL, {
      ...googleEvent(id, {
        etag: '"555"',
        updated: '2026-10-23T09:00:00.000Z',
        summary: 'Ya estaba',
      }),
      extendedProperties: { private: { organizadorId: LOCAL } },
    });
    const res = await insertEvent(fullEnv(), { calendarId: CAL, localId: LOCAL, fields: timed });
    expect(res.created).toBe(false);
    expect(calls().map((r) => r.method)).toEqual(['POST', 'GET']);
    expect(await row(CAL, id)).toMatchObject({
      etag: '"555"',
      summary: 'Ya estaba',
      origin: 'app',
      local_id: LOCAL,
      updated: '2026-10-23T09:00:00.000Z',
    });
  });

  it('reintento tras 5xx que SI llego: el segundo intento da 409 y se trata como exito', async () => {
    const id = await eventIdFor(LOCAL);
    // Primer intento: Google lo crea pero responde 503.
    google.put(CAL, {
      ...googleEvent(id),
      extendedProperties: { private: { organizadorId: LOCAL } },
    });
    google.queue.push(gError(503, 'backendError'));
    const res = await insertEvent(
      fullEnv(),
      { calendarId: CAL, localId: LOCAL, fields: timed },
      noSleep,
    );
    expect(res.created).toBe(false);
    expect(calls().map((r) => r.method)).toEqual(['POST', 'POST', 'GET']);
    expect(sleeps).toHaveLength(1);
  });

  it('409 con un evento AJENO con ese id -> duplicate (no se adopta)', async () => {
    const id = await eventIdFor(LOCAL);
    google.put(CAL, googleEvent(id));
    const e = await err(insertEvent(fullEnv(), { calendarId: CAL, localId: LOCAL, fields: timed }));
    expect(e).toBeInstanceOf(GoogleWriteError);
    expect((e as GoogleWriteError).kind).toBe('duplicate');
    expect(await row(CAL, id)).toBeNull();
  });

  it('409 y el existente esta borrado (cancelled) -> gone', async () => {
    const id = await eventIdFor(LOCAL);
    google.put(CAL, { id, status: 'cancelled', etag: '"9"' });
    const e = await err(insertEvent(fullEnv(), { calendarId: CAL, localId: LOCAL, fields: timed }));
    expect((e as GoogleWriteError).kind).toBe('gone');
  });

  it.each([
    ['reader', READER, 'read_only'],
    ['freeBusyReader', 'fb@x', 'read_only'],
    ['sin rol', 'null@x', 'read_only'],
    ['desaparecido de Google', 'gone@x', 'calendar_not_found'],
    ['inexistente', 'nope@x', 'calendar_not_found'],
  ])('calendario %s -> %s sin llamar a Google', async (_n, cal, kind) => {
    await addCalendar('fb@x', 'freeBusyReader');
    await addCalendar('null@x', null);
    await addCalendar('gone@x', 'owner', { removed_at: '2026-10-01T00:00:00.000Z' });
    await env.DB.prepare('DELETE FROM google_auth').run(); // ni siquiera se pide token
    for (const p of [
      insertEvent(fullEnv(), { calendarId: cal, localId: LOCAL, fields: timed }),
      patchEvent(fullEnv(), {
        calendarId: cal,
        eventId: 'e1',
        etag: '"1"',
        fields: { summary: 'x' },
      }),
      deleteEvent(fullEnv(), { calendarId: cal, eventId: 'e1', etag: '"1"' }),
    ]) {
      const e = await err(p);
      expect(e).toBeInstanceOf(GoogleWriteError);
      expect((e as GoogleWriteError).kind).toBe(kind);
    }
    expect(google.requests).toHaveLength(0);
  });

  it('payload invalido -> invalid_payload sin red', async () => {
    const e = await err(
      insertEvent(fullEnv(), { calendarId: CAL, localId: LOCAL, fields: { summary: 'x' } }),
    );
    expect((e as GoogleWriteError).kind).toBe('invalid_payload');
    const e2 = await err(
      insertEvent(fullEnv(), { calendarId: CAL, localId: 'mal id', fields: timed }),
    );
    expect((e2 as GoogleWriteError).kind).toBe('invalid_payload');
    expect(google.requests).toHaveLength(0);
  });

  it('Google desconectado -> GoogleAuthError not_connected sin llamar a Calendar', async () => {
    await env.DB.prepare('DELETE FROM google_auth').run();
    const e = await err(insertEvent(fullEnv(), { calendarId: CAL, localId: LOCAL, fields: timed }));
    expect(e).toBeInstanceOf(GoogleAuthError);
    expect((e as GoogleAuthError).code).toBe('not_connected');
    expect(calls()).toHaveLength(0);
  });
});

describe('patchEvent', () => {
  beforeEach(async () => {
    await seedEvent(CAL, 'e1', { pending_op: 'patch', pending_since: '2026-10-23T09:59:00.000Z' });
    google.put(CAL, googleEvent('e1'));
  });

  it('If-Match con el etag del body; guarda etag nuevo del BODY (no el header) y updated', async () => {
    const res = await patchEvent(fullEnv(), {
      calendarId: CAL,
      eventId: 'e1',
      etag: '"100"',
      fields: { summary: 'Despues', location: null },
    });
    const [r] = calls();
    expect(r!.method).toBe('PATCH');
    expect(r!.url).toBe(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events/e1?sendUpdates=none`,
    );
    expect(r!.headers['if-match']).toBe('"100"');
    expect(JSON.parse(r!.body!)).toEqual({ summary: 'Despues', location: '' });
    const newEtag = google.store.get(`${CAL}/e1`)!.etag as string;
    expect(res.event.etag).toBe(newEtag);
    expect(await row(CAL, 'e1')).toMatchObject({
      summary: 'Despues',
      location: null,
      etag: newEtag,
      updated: new Date(NOW).toISOString(),
      pending_op: null,
      origin: 'google',
      local_id: null,
    });
  });

  it('412 (etag viejo) -> conflict y D1 intacto (pending se conserva)', async () => {
    const e = await err(
      patchEvent(fullEnv(), {
        calendarId: CAL,
        eventId: 'e1',
        etag: '"099"',
        fields: { summary: 'X' },
      }),
    );
    expect(e).toBeInstanceOf(GoogleWriteError);
    expect((e as GoogleWriteError).kind).toBe('conflict');
    expect((e as GoogleWriteError).status).toBe(412);
    expect(await row(CAL, 'e1')).toMatchObject({
      summary: 'Antes',
      etag: '"100"',
      pending_op: 'patch',
    });
    expect(calls()).toHaveLength(1); // 412 no se reintenta
  });

  it('404/410 -> not_found/gone', async () => {
    google.queue.push(gError(404, 'notFound'), gError(410, 'deleted'));
    const args = { calendarId: CAL, eventId: 'e1', etag: '"100"', fields: { summary: 'X' } };
    expect(((await err(patchEvent(fullEnv(), args))) as GoogleWriteError).kind).toBe('not_found');
    expect(((await err(patchEvent(fullEnv(), args))) as GoogleWriteError).kind).toBe('gone');
  });

  it('etag ausente o con saltos de linea -> invalid_payload sin red', async () => {
    for (const etag of ['', '"1"\n', null as unknown as string]) {
      const e = await err(
        patchEvent(fullEnv(), { calendarId: CAL, eventId: 'e1', etag, fields: { summary: 'X' } }),
      );
      expect((e as GoogleWriteError).kind).toBe('invalid_payload');
    }
    expect(calls()).toHaveLength(0);
  });

  it('no retrocede: si D1 ya tiene una version mas nueva no la pisa, pero limpia pending', async () => {
    await env.DB.prepare(
      `UPDATE events SET summary = 'Mas nueva', updated = '2026-10-23T11:00:00.000Z' WHERE id = 'e1'`,
    ).run();
    await patchEvent(fullEnv(), {
      calendarId: CAL,
      eventId: 'e1',
      etag: '"100"',
      fields: { summary: 'X' },
    });
    expect(await row(CAL, 'e1')).toMatchObject({ summary: 'Mas nueva', pending_op: null });
  });

  it('respuesta sin evento valido -> bad_response y D1 intacto', async () => {
    google.queue.push(json({ foo: 1 }));
    const e = await err(
      patchEvent(fullEnv(), {
        calendarId: CAL,
        eventId: 'e1',
        etag: '"100"',
        fields: { summary: 'X' },
      }),
    );
    expect((e as GoogleWriteError).kind).toBe('bad_response');
    expect(await row(CAL, 'e1')).toMatchObject({ pending_op: 'patch' });
  });
});

describe('deleteEvent', () => {
  beforeEach(async () => {
    await seedEvent(CAL, 'e1', { pending_op: 'delete' });
    google.put(CAL, googleEvent('e1'));
    await env.DB.prepare(
      `INSERT INTO event_meta (calendar_id, scope, target_id, notes, updated_at)
       VALUES (?1, 'instance', 'e1', 'nota', '2026-10-01T00:00:00Z')`,
    )
      .bind(CAL)
      .run();
  });

  it('204: If-Match, sendUpdates=none, borra la fila (la meta no se toca aqui)', async () => {
    const res = await deleteEvent(fullEnv(), { calendarId: CAL, eventId: 'e1', etag: '"100"' });
    expect(res.alreadyDeleted).toBe(false);
    const [r] = calls();
    expect(r!.method).toBe('DELETE');
    expect(r!.headers['if-match']).toBe('"100"');
    expect(new URL(r!.url).search).toBe('?sendUpdates=none');
    expect(await row(CAL, 'e1')).toBeNull();
    const meta = await env.DB.prepare('SELECT COUNT(*) AS n FROM event_meta').first<{
      n: number;
    }>();
    expect(meta!.n).toBe(1);
  });

  it('410 (ya borrado) = exito', async () => {
    await deleteEvent(fullEnv(), { calendarId: CAL, eventId: 'e1', etag: '"100"' });
    await seedEvent(CAL, 'e1', { pending_op: 'delete' });
    const res = await deleteEvent(fullEnv(), { calendarId: CAL, eventId: 'e1', etag: '"100"' });
    expect(res.alreadyDeleted).toBe(true);
    expect(calls()[1]!.method).toBe('DELETE');
    expect(await row(CAL, 'e1')).toBeNull();
  });

  it('404 = exito', async () => {
    google.queue.push(gError(404, 'notFound'));
    const res = await deleteEvent(fullEnv(), { calendarId: CAL, eventId: 'e1', etag: '"100"' });
    expect(res.alreadyDeleted).toBe(true);
    expect(await row(CAL, 'e1')).toBeNull();
  });

  it('412 -> conflict y la fila se conserva', async () => {
    const e = await err(deleteEvent(fullEnv(), { calendarId: CAL, eventId: 'e1', etag: '"1"' }));
    expect((e as GoogleWriteError).kind).toBe('conflict');
    expect(await row(CAL, 'e1')).not.toBeNull();
  });
});

describe('errores de Google', () => {
  const doPatch = () =>
    patchEvent(
      fullEnv(),
      { calendarId: CAL, eventId: 'e1', etag: '"100"', fields: { summary: 'X' } },
      noSleep,
    );
  beforeEach(async () => {
    await seedEvent(CAL, 'e1', { pending_op: 'patch' });
    google.put(CAL, googleEvent('e1'));
  });

  it.each([
    [401, 'authError'],
    [403, 'insufficientPermissions'],
  ])('%i %s -> not_connected, olvida el access token, sin reintentos', async (status, reason) => {
    google.queue.push(gError(status, reason));
    const e = await err(doPatch());
    expect(e).toBeInstanceOf(GoogleAuthError);
    expect((e as GoogleAuthError).code).toBe('not_connected');
    const auth = await env.DB.prepare('SELECT access_token FROM google_auth').first<Row>();
    expect(auth!.access_token).toBeNull();
    expect(calls()).toHaveLength(1);
    expect(await row(CAL, 'e1')).toMatchObject({ pending_op: 'patch', summary: 'Antes' });
  });

  it.each([
    [403, 'forbidden', 'forbidden'],
    [403, 'requiredAccessLevel', 'forbidden'],
    [403, 'rateLimitExceeded', 'rate_limited'],
    [403, 'userRateLimitExceeded', 'rate_limited'],
    [403, 'quotaExceeded', 'rate_limited'],
    [429, 'rateLimitExceeded', 'rate_limited'],
    [400, 'invalid', 'bad_request'],
    [409, 'duplicate', 'duplicate'],
  ])('%i %s -> %s sin reintentos', async (status, reason, kind) => {
    google.queue.push(gError(status, reason));
    const e = await err(doPatch());
    expect(e).toBeInstanceOf(GoogleWriteError);
    expect((e as GoogleWriteError).kind).toBe(kind);
    expect((e as GoogleWriteError).reason).toBe(reason);
    expect(calls()).toHaveLength(1);
  });

  it('403 de calendario de solo lectura en Google (D1 desactualizado) -> forbidden en insert', async () => {
    google.queue.push(gError(403, 'forbidden'));
    const e = await err(insertEvent(fullEnv(), { calendarId: CAL, localId: LOCAL, fields: timed }));
    expect((e as GoogleWriteError).kind).toBe('forbidden');
    expect(await row(CAL, await eventIdFor(LOCAL))).toBeNull();
  });

  it('5xx transitorio: reintenta (max 2) con backoff y luego acierta', async () => {
    google.queue.push(gError(500, 'backendError'), gError(503, 'backendError'));
    await doPatch();
    expect(calls()).toHaveLength(3);
    expect(sleeps).toEqual([retryDelayMs(1, 0.5), retryDelayMs(2, 0.5)]);
    expect(await row(CAL, 'e1')).toMatchObject({ summary: 'X', pending_op: null });
  });

  it('5xx persistente -> transient tras 3 intentos', async () => {
    google.queue.push(gError(500, 'x'), gError(502, 'x'), gError(503, 'x'));
    const e = await err(doPatch());
    expect((e as GoogleWriteError).kind).toBe('transient');
    expect(calls()).toHaveLength(3);
  });

  it('fallo de red/timeout -> transient (status 0)', async () => {
    google.queue.push(new TypeError('net'), new TypeError('net'), new TypeError('net'));
    const e = await err(doPatch());
    expect((e as GoogleWriteError).kind).toBe('transient');
    expect((e as GoogleWriteError).status).toBe(0);
  });
});

describe('writeErrors', () => {
  it('retryDelayMs crece, con jitter y acotado', () => {
    expect(retryDelayMs(1, 0)).toBe(150);
    expect(retryDelayMs(1, 1)).toBe(450);
    expect(retryDelayMs(2, 0.5)).toBe(600);
    expect(retryDelayMs(10, 1)).toBe(2000);
  });

  it('withRetries no reintenta errores que no son de Google ni >2 veces', async () => {
    let n = 0;
    await expect(
      withRetries(
        async () => {
          n++;
          throw new Error('bug');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('bug');
    expect(n).toBe(1);
    n = 0;
    await expect(
      withRetries(
        async () => {
          n++;
          throw new GoogleApiError(500);
        },
        { retries: 9, sleep: async () => {} },
      ),
    ).rejects.toThrow();
    expect(n).toBe(3);
  });

  it('classifyWriteError', () => {
    expect(classifyWriteError(new GoogleApiError(412, 'conditionNotMet'))).toBe('conflict');
    expect(classifyWriteError(new GoogleApiError(410, 'deleted'))).toBe('gone');
    expect(classifyWriteError(new GoogleApiError(0))).toBe('transient');
    expect(classifyWriteError(new GoogleApiError(418))).toBe('bad_response');
    expect(classifyWriteError(new PayloadError('x'))).toBe('invalid_payload');
  });
});

describe('getEvent', () => {
  it('devuelve la version actual o null si no existe; no escribe en D1', async () => {
    google.put(CAL, googleEvent('e1', { etag: '"77"' }));
    expect((await getEvent(fullEnv(), CAL, 'e1'))!.etag).toBe('"77"');
    expect(await getEvent(fullEnv(), CAL, 'nope')).toBeNull();
    expect(await row(CAL, 'e1')).toBeNull();
  });
});

describe('contrato con la purga del sync completo (T2.4)', () => {
  it('una escritura confirmada durante la pasada completa conserva `updated` y no se purga', async () => {
    // La pasada completa empieza ANTES de la escritura; Google no devuelve el evento en events.list
    // (p. ej. pagina ya leida). Su `updated` (de la respuesta) es posterior al inicio del run.
    const res = await insertEvent(fullEnv(), { calendarId: CAL, localId: LOCAL, fields: timed });
    google.store.clear();
    // Fila vieja sin pending ni updated reciente: SI se purga (control).
    await seedEvent(CAL, 'viejo', { updated: '2026-10-01T00:00:00.000Z' });
    const r = await runSync(fullEnv(), { nowMs: NOW - 60_000 });
    expect(r.failed).toBe(0);
    expect(r.completed).toBe(2); // CAL y READER
    expect(await row(CAL, res.event.id)).toMatchObject({ updated: new Date(NOW).toISOString() });
    expect(await row(CAL, 'viejo')).toBeNull();
  });

  it('carrera: un lote de sync viejo no pisa una fila ya actualizada por una escritura', async () => {
    await seedEvent(CAL, 'e1', {
      summary: 'Nuevo (escritura)',
      etag: '"200"',
      updated: '2026-10-22T00:00:00.000Z',
    });
    google.put(
      CAL,
      googleEvent('e1', { summary: 'Viejo', etag: '"150"', updated: '2026-10-10T00:00:00.000Z' }),
    );
    await runSync(fullEnv(), { nowMs: NOW });
    expect(await row(CAL, 'e1')).toMatchObject({
      summary: 'Nuevo (escritura)',
      etag: '"200"',
      updated: '2026-10-22T00:00:00.000Z',
    });
    // Control: un lote con updated mas nuevo si actualiza.
    google.put(
      CAL,
      googleEvent('e1', {
        summary: 'Mas nuevo',
        etag: '"300"',
        updated: '2026-10-23T00:00:00.000Z',
      }),
    );
    await runSync(fullEnv(), { nowMs: NOW });
    expect(await row(CAL, 'e1')).toMatchObject({ summary: 'Mas nuevo', etag: '"300"' });
  });
});
