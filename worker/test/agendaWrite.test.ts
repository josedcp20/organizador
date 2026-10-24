import { env } from 'cloudflare:workers';
import type { AgendaConflictBody, CalendarsResponse, EventInfo } from '@organizador/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import {
  applyGoogleEvent,
  IN_FLIGHT_STALE_MS,
  loadWriteRow,
  markChange,
  markInsert,
  newPendingMarker,
  revertWrite,
} from '../src/db/eventWrites';
import { writeRuntime } from '../src/google/agendaWrites';
import { deleteEvent } from '../src/google/eventsWrite';
import { eventIdFor } from '../src/google/eventPayload';
import { parseInstant } from '../src/routes/agendaInput';
import { parseGoogleEvent, type ParsedEvent } from '../src/sync/parse';
import { runSync } from '../src/sync/engine';
import {
  addCalendar,
  connect,
  FakeGoogle,
  fullEnv,
  gError,
  NOW,
  OAUTH_ENV,
  resetDb,
} from './googleFake';
import { call, clearFailures } from './helpers';

const CAL = 'pruebas@group.calendar.google.com';
const READER = 'compartido@gmail.com';
const CLIENT = '0d9c2b1e-4f6a-4c1b-9a3e-1234567890ab';

let google: FakeGoogle;

type Row = Record<string, unknown>;
const row = (cal: string, id: string) =>
  env.DB.prepare('SELECT * FROM events WHERE calendar_id = ?1 AND id = ?2')
    .bind(cal, id)
    .first<Row>();
const accessRole = async (cal: string) =>
  (await env.DB.prepare('SELECT access_role FROM calendars WHERE id = ?1')
    .bind(cal)
    .first<{ access_role: string | null }>())!.access_role;
const countEvents = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n;

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return call(path, {
    method,
    ip: '203.0.113.90',
    env: OAUTH_ENV,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const evPath = (cal: string, id: string, q = '') =>
  `/api/agenda/${encodeURIComponent(cal)}/${encodeURIComponent(id)}${q}`;
const writes = () => google.calendarRequests().filter((r) => r.method !== 'GET');

const createBody = (extra: Row = {}): Row => ({
  client_id: CLIENT,
  calendarId: CAL,
  summary: 'Dentista',
  location: 'Calle Mayor 1',
  description: 'Descripcion publica',
  allDay: false,
  start: '2026-11-02T09:00:00Z',
  end: '2026-11-02T10:00:00Z',
  ...extra,
});

/** Evento existente en D1 y en Google (mismo etag). */
async function seedEvent(id: string, d1: Row = {}, g: Row = {}, cal = CAL) {
  const r: Row = {
    status: 'confirmed',
    summary: 'Antes',
    all_day: 0,
    start_at: '2026-11-05T09:00:00.000Z',
    end_at: '2026-11-05T10:00:00.000Z',
    etag: '"100"',
    updated: '2026-10-01T00:00:00.000Z',
    origin: 'google',
    ...d1,
  };
  const cols = Object.keys(r);
  await env.DB.prepare(
    `INSERT INTO events (calendar_id, id, ${cols.join(', ')})
     VALUES (?1, ?2, ${cols.map((_, i) => `?${i + 3}`).join(', ')})`,
  )
    .bind(cal, id, ...cols.map((c) => r[c]))
    .run();
  google.put(cal, {
    kind: 'calendar#event',
    id,
    status: 'confirmed',
    etag: r.etag,
    updated: r.updated,
    summary: r.summary,
    start: { dateTime: r.start_at },
    end: { dateTime: r.end_at },
    ...g,
  });
}

async function seedMeta(scope: 'instance' | 'series', target: string, notes: string) {
  await env.DB.prepare(
    `INSERT INTO event_meta (calendar_id, scope, target_id, notes, updated_at)
     VALUES (?1, ?2, ?3, ?4, '2026-10-20T00:00:00.000Z')`,
  )
    .bind(CAL, scope, target, notes)
    .run();
}
const metaCount = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM event_meta').first<{ n: number }>())!.n;

beforeEach(async () => {
  await resetDb();
  google = new FakeGoogle();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => google.handle(input, init)),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  writeRuntime.retry = { sleep: async () => {} };
  await connect();
  await addCalendar(CAL, 'owner');
  await addCalendar(READER, 'reader');
});

afterEach(() => {
  writeRuntime.retry = undefined;
  setClock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe('POST /api/agenda', () => {
  it('crea en Google con id determinista y lo guarda en D1 (origin app, etag/updated del body)', async () => {
    const res = await send('POST', '/api/agenda', createBody());
    expect(res.status).toBe(201);
    const ev = (await res.json()) as EventInfo;
    const id = await eventIdFor(CLIENT);
    expect(ev).toMatchObject({
      id,
      calendarId: CAL,
      origin: 'app',
      summary: 'Dentista',
      location: 'Calle Mayor 1',
      description: 'Descripcion publica',
      allDay: false,
      startAt: '2026-11-02T09:00:00.000Z',
      endAt: '2026-11-02T10:00:00.000Z',
      pending: null,
      writable: true,
    });
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.method).toBe('POST');
    const body = JSON.parse(w[0]!.body!) as Row;
    expect(body.id).toBe(id);
    expect(body.extendedProperties).toEqual({ private: { organizadorId: CLIENT } });
    const r = await row(CAL, id);
    expect(r).toMatchObject({
      local_id: CLIENT,
      origin: 'app',
      pending_op: null,
      pending_payload: null,
      updated: new Date(NOW).toISOString(),
    });
    expect(r!.etag).toBe(google.store.get(`${CAL}/${id}`)!.etag);
  });

  it('dia completo con fin exclusivo y hora local de Madrid sin desfase', async () => {
    const a = await send(
      'POST',
      '/api/agenda',
      createBody({ allDay: true, start: '2026-11-10', end: '2026-11-11' }),
    );
    expect(a.status).toBe(201);
    expect(await a.json()).toMatchObject({
      allDay: true,
      startDate: '2026-11-10',
      endDate: '2026-11-11',
    });
    const b = await send(
      'POST',
      '/api/agenda',
      createBody({
        client_id: 'otro-cliente-1',
        start: '2026-11-02T10:00',
        end: '2026-11-02T11:30',
      }),
    );
    expect(b.status).toBe(201);
    // Noviembre: Madrid = UTC+1.
    expect(await b.json()).toMatchObject({
      startAt: '2026-11-02T09:00:00.000Z',
      endAt: '2026-11-02T10:30:00.000Z',
    });
  });

  it('POST repetido con el mismo client_id: mismo evento, sin segundo insert', async () => {
    const first = (await (await send('POST', '/api/agenda', createBody())).json()) as EventInfo;
    const again = await send('POST', '/api/agenda', createBody());
    expect(again.status).toBe(200);
    expect(((await again.json()) as EventInfo).id).toBe(first.id);
    expect(writes()).toHaveLength(1);
    expect(await countEvents()).toBe(1);
  });

  it('respuesta perdida: el reintento recibe 409 duplicate de Google y se trata como exito', async () => {
    await send('POST', '/api/agenda', createBody());
    const id = await eventIdFor(CLIENT);
    // Simula que la primera respuesta no llego: la fila sigue pendiente de insert.
    await env.DB.prepare(
      `UPDATE events SET pending_op = 'insert', pending_since = 'x', pending_payload = 'y',
         write_error = 'transient' WHERE id = ?1`,
    )
      .bind(id)
      .run();
    const res = await send('POST', '/api/agenda', createBody());
    expect(res.status).toBe(201);
    expect(writes().map((r) => r.method)).toEqual(['POST', 'POST']);
    expect(await row(CAL, id)).toMatchObject({ pending_op: null, local_id: CLIENT });
    expect(await countEvents()).toBe(1);
  });

  it('el eco del sync no duplica el evento creado', async () => {
    await send('POST', '/api/agenda', createBody());
    await runSync(fullEnv(), { nowMs: NOW });
    expect(await countEvents()).toBe(1);
    const r = await row(CAL, await eventIdFor(CLIENT));
    expect(r).toMatchObject({ origin: 'app', local_id: CLIENT, summary: 'Dentista' });
  });

  it('calendario reader, inexistente o desaparecido -> 403 calendar_forbidden sin red', async () => {
    await addCalendar('gone@x', 'owner', { removed_at: '2026-10-01T00:00:00.000Z' });
    for (const calendarId of [READER, 'nope@x', 'gone@x']) {
      const res = await send('POST', '/api/agenda', createBody({ calendarId }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'calendar_forbidden' } });
    }
    expect(google.requests).toHaveLength(0);
    expect(await countEvents()).toBe(0);
  });

  it('Google 403 -> se revierte D1 (sin fila), calendar_forbidden y el calendario pasa a reader', async () => {
    google.queue.push(gError(403, 'forbidden'));
    const res = await send('POST', '/api/agenda', createBody());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'calendar_forbidden' } });
    expect(await countEvents()).toBe(0);
    expect(await accessRole(CAL)).toBe('reader');
    // GET /api/calendars deja de ofrecerlo para escribir y el siguiente POST no llama a Google.
    const cals = (await (await send('GET', '/api/calendars')).json()) as CalendarsResponse;
    expect(cals.calendars.find((c) => c.id === CAL)).toMatchObject({
      accessRole: 'reader',
      writable: false,
    });
    const n = google.requests.length;
    expect((await send('POST', '/api/agenda', createBody())).status).toBe(403);
    expect(google.requests).toHaveLength(n);
  });

  it('403 forbiddenForNonOrganizer, razon desconocida: 403 calendar_forbidden sin bajar el rol', async () => {
    for (const reason of ['forbiddenForNonOrganizer', 'algoRaro']) {
      google.queue.push(gError(403, reason));
      const res = await send('POST', '/api/agenda', createBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'calendar_forbidden' } });
      expect(await countEvents()).toBe(0);
      expect(await accessRole(CAL)).toBe('owner');
    }
    const cals = (await (await send('GET', '/api/calendars')).json()) as CalendarsResponse;
    expect(cals.calendars.find((c) => c.id === CAL)).toMatchObject({ writable: true });
  });

  it('403 requiredAccessLevel baja el rol; dailyLimitExceeded -> 202 pendiente sin bajarlo', async () => {
    google.queue.push(gError(403, 'dailyLimitExceeded'));
    const a = await send('POST', '/api/agenda', createBody());
    expect(a.status).toBe(202);
    expect(await accessRole(CAL)).toBe('owner');
    await resetDb();
    await connect();
    await addCalendar(CAL, 'owner');
    google.queue.push(gError(403, 'requiredAccessLevel'));
    expect((await send('POST', '/api/agenda', createBody())).status).toBe(403);
    expect(await accessRole(CAL)).toBe('reader');
  });

  it('carrera de client_id en dos calendarios: la restriccion unica da 409 duplicate, no 500', async () => {
    const CAL2 = 'otro@group.calendar.google.com';
    await addCalendar(CAL2, 'owner');
    const id = await eventIdFor(CLIENT);
    // Simula otro POST simultaneo: justo antes del alta optimista aparece el local_id en CAL2.
    await env.DB.exec(
      `CREATE TRIGGER race BEFORE INSERT ON events WHEN NEW.calendar_id = '${CAL}'
         AND NOT EXISTS (SELECT 1 FROM events WHERE local_id = NEW.local_id)
       BEGIN INSERT INTO events (calendar_id, id, status, all_day, origin, local_id)
         VALUES ('${CAL2}', '${id}', 'confirmed', 0, 'app', NEW.local_id); END`.replace(
        /\s+/g,
        ' ',
      ),
    );
    const res = await send('POST', '/api/agenda', createBody());
    await env.DB.exec('DROP TRIGGER race');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'duplicate' } });
    expect(await row(CAL, id)).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('403 de cuota (rateLimitExceeded) no es de permiso: no baja el rol del calendario', async () => {
    google.queue.push(gError(403, 'rateLimitExceeded'));
    const res = await send('POST', '/api/agenda', createBody());
    expect(res.status).toBe(202);
    expect(await accessRole(CAL)).toBe('owner');
  });

  it('transitorio (5xx tras reintentos) -> 202 con pending insert y payload guardado', async () => {
    google.queue.push(gError(503, 'backendError'), gError(503, 'backendError'), gError(503, 'x'));
    const res = await send('POST', '/api/agenda', createBody());
    expect(res.status).toBe(202);
    const ev = (await res.json()) as EventInfo;
    expect(ev.pending).toEqual({ op: 'insert', error: 'transient' });
    expect(ev.origin).toBe('app');
    const r = (await row(CAL, ev.id))!;
    expect(r).toMatchObject({ pending_op: 'insert', pending_attempts: 1, local_id: CLIENT });
    const payload = JSON.parse(r.pending_payload as string) as Row;
    expect(payload).toMatchObject({
      v: 1,
      op: 'insert',
      fields: { summary: 'Dentista', location: 'Calle Mayor 1' },
    });
    // Repetir el POST lo completa (mismo id, sin duplicar).
    const again = await send('POST', '/api/agenda', createBody());
    expect(again.status).toBe(201);
    expect(await row(CAL, ev.id)).toMatchObject({ pending_op: null });
    expect(await countEvents()).toBe(1);
  });

  it('Google desconectado -> 409 google_not_connected y D1 revertido', async () => {
    await env.DB.prepare('DELETE FROM google_auth').run();
    const res = await send('POST', '/api/agenda', createBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'google_not_connected' } });
    expect(await countEvents()).toBe(0);
  });

  it('client_id reutilizado en otro calendario -> 409 duplicate sin red', async () => {
    await addCalendar('otro@x', 'writer');
    await send('POST', '/api/agenda', createBody());
    const res = await send('POST', '/api/agenda', createBody({ calendarId: 'otro@x' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'duplicate' } });
    expect(writes()).toHaveLength(1);
  });

  it('inicio anterior a la ventana de sync -> 423 frozen', async () => {
    const res = await send(
      'POST',
      '/api/agenda',
      createBody({ start: '2026-08-01T09:00:00Z', end: '2026-08-01T10:00:00Z' }),
    );
    expect(res.status).toBe(423);
    expect(google.requests).toHaveLength(0);
  });

  it('validacion de cuerpo y fechas (400, sin red)', async () => {
    const bad: Row[] = [
      createBody({ end: '2026-11-02T08:59:59Z' }), // fin < inicio
      createBody({ allDay: true, start: '2026-11-10', end: '2026-11-10' }), // fin exclusivo
      createBody({ allDay: true, start: '2026-11-10', end: '2026-11-09' }),
      createBody({ allDay: true, start: '2026-02-30', end: '2026-03-01' }),
      createBody({ allDay: true, start: '2026-11-10T00:00:00Z', end: '2026-11-11' }),
      createBody({ start: '2026-11-02', end: '2026-11-03' }), // con hora sin hora
      createBody({ start: '2026-11-02T25:00', end: '2026-11-02T26:00' }),
      createBody({ start: 'manana', end: 'pasado' }),
      createBody({ allDay: 'no' }),
      createBody({ summary: '   ' }),
      createBody({ summary: 'x'.repeat(1025) }),
      createBody({ client_id: 'con espacios' }),
      createBody({ client_id: undefined }),
      createBody({ calendarId: '' }),
      createBody({ notes: 'privado' }), // meta privada nunca por aqui
      createBody({ color: '#ff0000' }),
      createBody({ recurrence: ['RRULE:FREQ=DAILY'] }),
    ];
    for (const b of bad) {
      const res = await send('POST', '/api/agenda', b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'validation' } });
    }
    const notJson = await call('/api/agenda', {
      method: 'POST',
      ip: '203.0.113.90',
      env: OAUTH_ENV,
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(notJson.status).toBe(400);
    expect(google.requests).toHaveLength(0);
  });

  it('fin igual a inicio con hora es valido (duracion 0)', async () => {
    const res = await send('POST', '/api/agenda', createBody({ end: '2026-11-02T09:00:00Z' }));
    expect(res.status).toBe(201);
  });
});

describe('parseInstant', () => {
  it('ISO con desfase y hora local de Madrid (verano/invierno)', () => {
    expect(parseInstant('2026-07-01T10:00', 'Europe/Madrid')).toBe('2026-07-01T08:00:00.000Z');
    expect(parseInstant('2026-12-01T10:00:30', 'Europe/Madrid')).toBe('2026-12-01T09:00:30.000Z');
    expect(parseInstant('2026-07-01T10:00:00+02:00', 'Europe/Madrid')).toBe(
      '2026-07-01T08:00:00.000Z',
    );
    expect(parseInstant('2026-13-01T10:00Z', 'Europe/Madrid')).toBeNull();
    expect(parseInstant('3000-01-01T10:00Z', 'Europe/Madrid')).toBeNull();
  });
});

describe('PATCH /api/agenda/:c/:e', () => {
  it('evento de la app: patch con If-Match del etag de D1 y aplica la respuesta', async () => {
    await seedEvent('e1', { origin: 'app', local_id: 'loc-1' });
    const res = await send('PATCH', evPath(CAL, 'e1'), {
      summary: 'Despues',
      location: null,
      allDay: false,
      start: '2026-11-06T09:00:00Z',
      end: '2026-11-06T11:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      summary: 'Despues',
      startAt: '2026-11-06T09:00:00.000Z',
      endAt: '2026-11-06T11:00:00.000Z',
      pending: null,
    });
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.headers['if-match']).toBe('"100"');
    const body = JSON.parse(w[0]!.body!) as Row;
    expect(Object.keys(body).sort()).toEqual(['end', 'location', 'start', 'summary']);
    expect(body.location).toBe('');
    const r = (await row(CAL, 'e1'))!;
    expect(r.etag).toBe(google.store.get(`${CAL}/e1`)!.etag);
    expect(r).toMatchObject({ pending_op: null, updated: new Date(NOW).toISOString() });
  });

  it('evento de Google sin confirm_external -> 428 sin llamar a Google', async () => {
    await seedEvent('e1');
    for (const body of [{ summary: 'X' }, { summary: 'X', confirm_external: false }]) {
      const res = await send('PATCH', evPath(CAL, 'e1'), body);
      expect(res.status).toBe(428);
      expect(await res.json()).toMatchObject({ error: { code: 'confirmation_required' } });
    }
    expect(google.requests).toHaveLength(0);
    expect(await row(CAL, 'e1')).toMatchObject({ summary: 'Antes', pending_op: null });
    const ok = await send('PATCH', evPath(CAL, 'e1'), { summary: 'X', confirm_external: true });
    expect(ok.status).toBe(200);
  });

  it('congelado (anterior a la ventana) o moverlo antes de la ventana -> 423', async () => {
    await seedEvent('old', {
      start_at: '2026-08-01T09:00:00.000Z',
      end_at: '2026-08-01T10:00:00.000Z',
    });
    await seedEvent('e1');
    const a = await send('PATCH', evPath(CAL, 'old'), { summary: 'X', confirm_external: true });
    expect(a.status).toBe(423);
    expect(await a.json()).toMatchObject({ error: { code: 'frozen' } });
    const b = await send('PATCH', evPath(CAL, 'e1'), {
      confirm_external: true,
      allDay: false,
      start: '2026-08-01T09:00:00Z',
      end: '2026-08-01T10:00:00Z',
    });
    expect(b.status).toBe(423);
    expect(google.requests).toHaveLength(0);
  });

  it('recurrente -> 501 recurring_not_supported; reader -> 403; inexistente -> 404', async () => {
    await seedEvent('inst_1', { recurring_event_id: 'serie1' });
    await seedEvent('r1', {}, {}, READER);
    const a = await send('PATCH', evPath(CAL, 'inst_1'), { summary: 'X', confirm_external: true });
    expect(a.status).toBe(501);
    expect(await a.json()).toMatchObject({ error: { code: 'recurring_not_supported' } });
    const b = await send('PATCH', evPath(READER, 'r1'), { summary: 'X', confirm_external: true });
    expect(b.status).toBe(403);
    expect(await b.json()).toMatchObject({ error: { code: 'calendar_forbidden' } });
    const c = await send('PATCH', evPath(CAL, 'nope'), { summary: 'X', confirm_external: true });
    expect(c.status).toBe(404);
    expect(google.requests).toHaveLength(0);
  });

  it('validacion: vacio, claves privadas, fechas sueltas, cambio dia completo <-> hora', async () => {
    await seedEvent('e1', { origin: 'app' });
    for (const body of [
      {},
      { notes: 'x' },
      { remind: true },
      { summary: '' },
      { start: '2026-11-06T09:00:00Z' },
      { allDay: false, start: '2026-11-06T09:00:00Z', end: '2026-11-06T08:00:00Z' },
      { confirm_external: 'yes', summary: 'X' },
      { allDay: true, start: '2026-11-06', end: '2026-11-07' },
    ]) {
      const res = await send('PATCH', evPath(CAL, 'e1'), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(google.requests).toHaveLength(0);
  });

  it('Google 403 -> revierte D1 a como estaba y la meta queda intacta', async () => {
    await seedEvent('e1', { origin: 'app', location: 'Sala' });
    await seedMeta('instance', 'e1', 'NOTA');
    const before = await row(CAL, 'e1');
    google.queue.push(gError(403, 'forbidden'));
    const res = await send('PATCH', evPath(CAL, 'e1'), { summary: 'Despues', location: null });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'calendar_forbidden' } });
    expect(await row(CAL, 'e1')).toEqual({ ...before, write_error: 'forbidden' });
    expect(await metaCount()).toBe(1);
    expect(await accessRole(CAL)).toBe('reader');
  });

  it('412 -> 409 conflict con la version actual de Google, ya aplicada en D1', async () => {
    await seedEvent('e1', { origin: 'app' });
    // Alguien lo cambio en Google: etag y titulo nuevos.
    google.put(CAL, {
      ...google.store.get(`${CAL}/e1`)!,
      etag: '"200"',
      summary: 'Cambiado en Google',
      updated: '2026-10-22T00:00:00.000Z',
    });
    const res = await send('PATCH', evPath(CAL, 'e1'), { summary: 'Mio' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as AgendaConflictBody;
    expect(body.error.code).toBe('conflict');
    expect(body.current).toMatchObject({ id: 'e1', summary: 'Cambiado en Google', pending: null });
    expect(await row(CAL, 'e1')).toMatchObject({
      summary: 'Cambiado en Google',
      etag: '"200"',
      pending_op: null,
    });
  });

  it('falso conflicto (el intento anterior SI se aplico): 412 + campos ya iguales = exito', async () => {
    await seedEvent('e1', { origin: 'app' });
    google.put(CAL, {
      ...google.store.get(`${CAL}/e1`)!,
      etag: '"200"',
      summary: 'Mio',
      updated: '2026-10-22T00:00:00.000Z',
    });
    const res = await send('PATCH', evPath(CAL, 'e1'), { summary: 'Mio' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ summary: 'Mio', pending: null });
    expect(await row(CAL, 'e1')).toMatchObject({ etag: '"200"', pending_op: null });
  });

  it('timeout que Google aplico + reintento en linea 412 -> exito (falso conflicto)', async () => {
    await seedEvent('e1', { origin: 'app' });
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await google.handle(input, init);
        if (first && init?.method === 'PATCH') {
          first = false;
          return gError(503, 'backendError'); // aplicado, pero la respuesta se pierde
        }
        return res;
      }),
    );
    const res = await send('PATCH', evPath(CAL, 'e1'), { summary: 'Mio' });
    expect(res.status).toBe(200);
    expect(writes().map((r) => r.method)).toEqual(['PATCH', 'PATCH']);
    expect(await row(CAL, 'e1')).toMatchObject({ summary: 'Mio', pending_op: null });
  });

  it('transitorio -> 202 con pending patch, valores optimistas y payload para T3.10', async () => {
    await seedEvent('e1', { origin: 'app' });
    google.queue.push(gError(500, 'x'), gError(502, 'x'), gError(503, 'x'));
    const res = await send('PATCH', evPath(CAL, 'e1'), { summary: 'Optimista' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      summary: 'Optimista',
      pending: { op: 'patch', error: 'transient' },
    });
    const r = (await row(CAL, 'e1'))!;
    expect(r).toMatchObject({ pending_op: 'patch', etag: '"100"', pending_attempts: 1 });
    expect(JSON.parse(r.pending_payload as string)).toMatchObject({
      op: 'patch',
      fields: { summary: 'Optimista' },
    });
    // Un patch posterior se FUSIONA con el pendiente y lo completa.
    const again = await send('PATCH', evPath(CAL, 'e1'), { location: 'Sala 2' });
    expect(again.status).toBe(200);
    const last = JSON.parse(writes().at(-1)!.body!) as Row;
    expect(last).toMatchObject({ summary: 'Optimista', location: 'Sala 2' });
    expect(await row(CAL, 'e1')).toMatchObject({ pending_op: null, summary: 'Optimista' });
  });

  it('el evento ya no existe en Google (404) -> se quita de D1 y 404', async () => {
    await seedEvent('e1', { origin: 'app' });
    google.store.delete(`${CAL}/e1`);
    const res = await send('PATCH', evPath(CAL, 'e1'), { summary: 'X' });
    expect(res.status).toBe(404);
    expect(await row(CAL, 'e1')).toBeNull();
  });

  it('un pendiente POSTERIOR (otra escritura durante la llamada) no se borra al confirmar', async () => {
    await seedEvent('e1', { origin: 'app' });
    const later = newPendingMarker('patch', { summary: 'Posterior' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          // Mientras Google responde, otra escritura toma la fila con su propia marca.
          await env.DB.prepare(
            `UPDATE events SET summary = 'Posterior', pending_op = ?1, pending_since = ?2,
               pending_payload = ?3 WHERE id = 'e1'`,
          )
            .bind(later.op, later.since, later.payload)
            .run();
        }
        return google.handle(input, init);
      }),
    );
    const res = await send('PATCH', evPath(CAL, 'e1'), { summary: 'Primero' });
    expect(res.status).toBe(200);
    const r = (await row(CAL, 'e1'))!;
    expect(r).toMatchObject({
      pending_op: 'patch',
      pending_since: later.since,
      pending_payload: later.payload,
      summary: 'Posterior',
    });
    // Pero adopta el etag confirmado (base correcta para el If-Match del posterior).
    expect(r.etag).toBe(google.store.get(`${CAL}/e1`)!.etag);
  });

  it('con un alta pendiente de confirmar -> 409 write_pending', async () => {
    await seedEvent('e1', { origin: 'app', pending_op: 'insert', etag: null });
    const res = await send('PATCH', evPath(CAL, 'e1'), { summary: 'X' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'write_pending' } });
    expect(google.requests).toHaveLength(0);
  });
});

describe('DELETE /api/agenda/:c/:e', () => {
  it('borra en Google (If-Match), quita la fila y la meta de instancia; la de serie no', async () => {
    await seedEvent('e1', { origin: 'app' });
    await seedMeta('instance', 'e1', 'NOTA');
    await seedMeta('series', 'serieX', 'SERIE');
    const res = await send('DELETE', evPath(CAL, 'e1'));
    expect(res.status).toBe(204);
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: 'DELETE', body: null });
    expect(w[0]!.headers['if-match']).toBe('"100"');
    expect(await row(CAL, 'e1')).toBeNull();
    const meta = await env.DB.prepare('SELECT scope FROM event_meta').all<{ scope: string }>();
    expect(meta.results).toEqual([{ scope: 'series' }]);
  });

  it('404/410 de Google = exito', async () => {
    await seedEvent('e1', { origin: 'app' });
    await seedEvent('e2', { origin: 'app' });
    google.store.delete(`${CAL}/e1`);
    google.put(CAL, { id: 'e2', status: 'cancelled', etag: '"100"' });
    expect((await send('DELETE', evPath(CAL, 'e1'))).status).toBe(204);
    expect((await send('DELETE', evPath(CAL, 'e2'))).status).toBe(204);
    expect(await countEvents()).toBe(0);
  });

  it('evento de Google: 428 sin confirm_external (query o cuerpo JSON lo confirman)', async () => {
    await seedEvent('e1');
    await seedEvent('e2');
    const res = await send('DELETE', evPath(CAL, 'e1'));
    expect(res.status).toBe(428);
    expect(google.requests).toHaveLength(0);
    expect((await send('DELETE', evPath(CAL, 'e1', '?confirm_external=true'))).status).toBe(204);
    expect((await send('DELETE', evPath(CAL, 'e2'), { confirm_external: true })).status).toBe(204);
    expect((await send('DELETE', evPath(CAL, 'e2', '?confirm_external=si'))).status).toBe(400);
  });

  it('423 congelado, 403 reader, 501 recurrente', async () => {
    await seedEvent('old', {
      origin: 'app',
      start_at: '2026-08-01T09:00:00.000Z',
      end_at: '2026-08-01T10:00:00.000Z',
    });
    await seedEvent('r1', { origin: 'app' }, {}, READER);
    await seedEvent('inst_1', { recurring_event_id: 'serie1' });
    expect((await send('DELETE', evPath(CAL, 'old'))).status).toBe(423);
    expect((await send('DELETE', evPath(READER, 'r1'))).status).toBe(403);
    expect((await send('DELETE', evPath(CAL, 'inst_1', '?confirm_external=true'))).status).toBe(
      501,
    );
    expect(google.requests).toHaveLength(0);
  });

  it('Google 403 -> fila y meta restauradas', async () => {
    await seedEvent('e1', { origin: 'app' });
    await seedMeta('instance', 'e1', 'NOTA');
    const before = await row(CAL, 'e1');
    google.queue.push(gError(403, 'forbidden'));
    const res = await send('DELETE', evPath(CAL, 'e1'));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'calendar_forbidden' } });
    expect(await row(CAL, 'e1')).toEqual({ ...before, write_error: 'forbidden' });
    expect(await metaCount()).toBe(1);
    expect(await accessRole(CAL)).toBe('reader');
  });

  it('transitorio -> 202 con pending delete; oculto en la lectura; meta intacta', async () => {
    await seedEvent('e1', { origin: 'app' });
    await seedMeta('instance', 'e1', 'NOTA');
    google.queue.push(gError(503, 'x'), gError(503, 'x'), new Error('network'));
    const res = await send('DELETE', evPath(CAL, 'e1'));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ id: 'e1', pending: { op: 'delete' } });
    expect(await row(CAL, 'e1')).toMatchObject({ pending_op: 'delete', pending_attempts: 1 });
    expect((await send('GET', evPath(CAL, 'e1'))).status).toBe(404);
    expect(await metaCount()).toBe(1);
  });

  it('412 -> 409 conflict con la version actual', async () => {
    await seedEvent('e1', { origin: 'app' });
    google.put(CAL, { ...google.store.get(`${CAL}/e1`)!, etag: '"300"', summary: 'Nuevo' });
    const res = await send('DELETE', evPath(CAL, 'e1'));
    expect(res.status).toBe(409);
    expect(((await res.json()) as AgendaConflictBody).current).toMatchObject({ summary: 'Nuevo' });
    expect(await row(CAL, 'e1')).toMatchObject({ etag: '"300"', pending_op: null });
  });
});

describe('marca pendiente (CLEAR_PENDING seguro)', () => {
  it('deleteEvent con marca ajena en la fila: no borra la fila de otra escritura posterior', async () => {
    await seedEvent('e1', { origin: 'app' });
    const mine = newPendingMarker('delete');
    const other = newPendingMarker('patch', { summary: 'X' });
    await env.DB.prepare(
      `UPDATE events SET pending_op = ?1, pending_since = ?2, pending_payload = ?3 WHERE id = 'e1'`,
    )
      .bind(other.op, other.since, other.payload)
      .run();
    await deleteEvent(
      fullEnv(),
      { calendarId: CAL, eventId: 'e1', etag: '"100"' },
      { pending: mine },
    );
    expect(await row(CAL, 'e1')).toMatchObject({ pending_payload: other.payload });
  });

  const parsed = (raw: Row): ParsedEvent => {
    const p = parseGoogleEvent(raw);
    if (p.kind !== 'event') throw new Error('bad');
    return p.event;
  };

  it('confirmar o revertir la escritura A no toca el pendiente posterior B', async () => {
    await seedEvent('e1', { origin: 'app' });
    const a = newPendingMarker('patch', { summary: 'A' });
    const b = newPendingMarker('patch', { summary: 'B' });
    await env.DB.prepare(
      `UPDATE events SET summary = 'B', pending_op = ?1, pending_since = ?2, pending_payload = ?3`,
    )
      .bind(b.op, b.since, b.payload)
      .run();
    const before = await loadWriteRow(env.DB, CAL, 'e1');
    await revertWrite(env.DB, before, CAL, 'e1', a);
    expect(await loadWriteRow(env.DB, CAL, 'e1')).toEqual(before);
    await applyGoogleEvent(
      env.DB,
      CAL,
      parsed({
        id: 'e1',
        etag: '"555"',
        updated: '2026-10-23T09:00:00.000Z',
        summary: 'A',
        start: { dateTime: '2026-11-05T09:00:00Z' },
        end: { dateTime: '2026-11-05T10:00:00Z' },
      }),
      { pending: a },
    );
    expect(await row(CAL, 'e1')).toMatchObject({
      summary: 'B',
      pending_payload: b.payload,
      etag: '"555"',
    });
    // Con SU marca si se limpia.
    await applyGoogleEvent(
      env.DB,
      CAL,
      parsed({
        id: 'e1',
        etag: '"556"',
        updated: '2026-10-23T09:30:00.000Z',
        summary: 'B',
        start: { dateTime: '2026-11-05T09:00:00Z' },
        end: { dateTime: '2026-11-05T10:00:00Z' },
      }),
      { pending: b },
    );
    expect(await row(CAL, 'e1')).toMatchObject({ summary: 'B', pending_op: null, etag: '"556"' });
  });
});

describe('/api/settings', () => {
  it('GET por defecto: ambos null', async () => {
    const res = await send('GET', '/api/settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ app_events_color: null, default_write_calendar: null });
  });

  it('PATCH guarda color (minusculas) y calendario writable; null borra', async () => {
    const res = await send('PATCH', '/api/settings', {
      app_events_color: '#AABBCC',
      default_write_calendar: CAL,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ app_events_color: '#aabbcc', default_write_calendar: CAL });
    const partial = await send('PATCH', '/api/settings', { app_events_color: null });
    expect(await partial.json()).toEqual({ app_events_color: null, default_write_calendar: CAL });
    expect(google.requests).toHaveLength(0);
  });

  it('validaciones: color, calendario reader/inexistente/desaparecido, claves desconocidas', async () => {
    await addCalendar('gone@x', 'owner', { removed_at: '2026-10-01T00:00:00.000Z' });
    for (const body of [
      {},
      { app_events_color: 'red' },
      { app_events_color: '#abc' },
      { default_write_calendar: READER },
      { default_write_calendar: 'nope@x' },
      { default_write_calendar: 'gone@x' },
      { default_write_calendar: 5 },
      { default_write_calendar: '' },
      { otro: 1 },
    ]) {
      const res = await send('PATCH', '/api/settings', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await (await send('GET', '/api/settings')).json()).toEqual({
      app_events_color: null,
      default_write_calendar: null,
    });
  });

  it('GET devuelve null si el calendario por defecto deja de ser writable', async () => {
    await send('PATCH', '/api/settings', { default_write_calendar: CAL });
    await env.DB.prepare(`UPDATE calendars SET access_role = 'reader' WHERE id = ?1`)
      .bind(CAL)
      .run();
    expect(await (await send('GET', '/api/settings')).json()).toMatchObject({
      default_write_calendar: null,
    });
  });

  it('app_events_color se usa como color de los eventos creados en la app', async () => {
    await send('PATCH', '/api/settings', { app_events_color: '#123456' });
    const ev = (await (await send('POST', '/api/agenda', createBody())).json()) as EventInfo;
    expect(ev.color).toBe('#123456');
  });
});

// ---------------------------------------------------------------------------------------------

/** Promesa que se resuelve a mano (para mantener una llamada a Google "en vuelo"). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/**
 * fetch que retiene la PRIMERA peticion a Calendar API con `method` hasta `release()`. `entered`
 * se resuelve cuando esa peticion ya salio (la escritura esta en vuelo).
 */
function holdFirst(method: string) {
  const entered = deferred();
  const gate = deferred();
  let held = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!held && init?.method === method && urlOf(input).includes('/calendar/v3/calendars/')) {
        held = true;
        entered.resolve();
        await gate.promise;
      }
      return google.handle(input, init);
    }),
  );
  return { entered: entered.promise, release: gate.resolve };
}

describe('escrituras concurrentes (en vuelo vs pendiente fallido)', () => {
  it('PATCH B con PATCH A en vuelo -> 409 write_pending sin llamar a Google; A confirma limpio', async () => {
    await seedEvent('e1', { origin: 'app' });
    const hold = holdFirst('PATCH');
    const a = send('PATCH', evPath(CAL, 'e1'), { summary: 'A' });
    await hold.entered;
    const b = await send('PATCH', evPath(CAL, 'e1'), { location: 'Sala B' });
    expect(b.status).toBe(409);
    expect(await b.json()).toMatchObject({ error: { code: 'write_pending' } });
    // La fila sigue con la marca de A (B no la toco).
    expect(JSON.parse((await row(CAL, 'e1'))!.pending_payload as string)).toMatchObject({
      fields: { summary: 'A' },
    });
    hold.release();
    expect((await a).status).toBe(200);
    expect(writes()).toHaveLength(1);
    const r = (await row(CAL, 'e1'))!;
    expect(r).toMatchObject({ summary: 'A', location: null, pending_op: null, write_error: null });
    expect(r.etag).toBe(google.store.get(`${CAL}/e1`)!.etag);
  });

  it('B reintentado tras A ok: va con el etag nuevo (sin 412/409 falso) y un 403 no deja fila atascada', async () => {
    await seedEvent('e1', { origin: 'app' });
    const hold = holdFirst('PATCH');
    const a = send('PATCH', evPath(CAL, 'e1'), { summary: 'A' });
    await hold.entered;
    expect((await send('PATCH', evPath(CAL, 'e1'), { location: 'Sala B' })).status).toBe(409);
    hold.release();
    expect((await a).status).toBe(200);
    const etagA = google.store.get(`${CAL}/e1`)!.etag;

    // B falla con 403: se revierte a lo confirmado por A, sin pendiente resucitado.
    google.queue.push(gError(403, 'forbidden'));
    expect((await send('PATCH', evPath(CAL, 'e1'), { location: 'Sala B' })).status).toBe(403);
    expect(await row(CAL, 'e1')).toMatchObject({
      summary: 'A',
      location: null,
      pending_op: null,
      pending_payload: null,
      etag: etagA,
      write_error: 'forbidden',
    });

    // Con permiso recuperado, B va con If-Match = etag de A y se confirma.
    await env.DB.prepare(`UPDATE calendars SET access_role = 'owner' WHERE id = ?1`)
      .bind(CAL)
      .run();
    const ok = await send('PATCH', evPath(CAL, 'e1'), { location: 'Sala B' });
    expect(ok.status).toBe(200);
    expect(writes().at(-1)!.headers['if-match']).toBe(etagA);
    expect(await row(CAL, 'e1')).toMatchObject({
      summary: 'A',
      location: 'Sala B',
      pending_op: null,
      write_error: null,
    });
  });

  it('DELETE con un PATCH en vuelo -> 409 write_pending', async () => {
    await seedEvent('e1', { origin: 'app' });
    const hold = holdFirst('PATCH');
    const a = send('PATCH', evPath(CAL, 'e1'), { summary: 'A' });
    await hold.entered;
    const d = await send('DELETE', evPath(CAL, 'e1'));
    expect(d.status).toBe(409);
    expect(await d.json()).toMatchObject({ error: { code: 'write_pending' } });
    hold.release();
    expect((await a).status).toBe(200);
    expect(writes().map((w) => w.method)).toEqual(['PATCH']);
    expect(await row(CAL, 'e1')).toMatchObject({ summary: 'A', pending_op: null });
  });

  it('POST concurrente con el mismo client_id: el segundo -> 409 write_pending, un solo insert', async () => {
    const id = await eventIdFor(CLIENT);
    const hold = holdFirst('POST');
    const a = send('POST', '/api/agenda', createBody());
    await hold.entered;
    const b = await send('POST', '/api/agenda', createBody({ summary: 'Otro titulo' }));
    expect(b.status).toBe(409);
    expect(await b.json()).toMatchObject({ error: { code: 'write_pending' } });
    hold.release();
    expect((await a).status).toBe(201);
    expect(writes()).toHaveLength(1);
    expect(await row(CAL, id)).toMatchObject({
      summary: 'Dentista',
      pending_op: null,
      local_id: CLIENT,
    });
    // Repetido despues: idempotente (200, sin llamar a Google).
    expect((await send('POST', '/api/agenda', createBody())).status).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it('POST repetido tras un alta FALLIDA (transitoria) si reescribe y la completa', async () => {
    google.queue.push(gError(503, 'x'), gError(503, 'x'), gError(503, 'x'));
    expect((await send('POST', '/api/agenda', createBody())).status).toBe(202);
    const again = await send('POST', '/api/agenda', createBody({ summary: 'Corregido' }));
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({ summary: 'Corregido', pending: null });
  });

  it('markInsert atomico: no pisa un alta en vuelo aunque la ruta no lo viera', async () => {
    const id = await eventIdFor(CLIENT);
    const hold = holdFirst('POST');
    const a = send('POST', '/api/agenda', createBody());
    await hold.entered;
    const inFlight = (await loadWriteRow(env.DB, CAL, id))!;
    const ok = await markInsert(
      env.DB,
      CAL,
      id,
      CLIENT,
      {
        summary: 'Intruso',
        time: { allDay: false, startAt: inFlight.start_at!, endAt: inFlight.end_at! },
      },
      newPendingMarker('insert', { summary: 'Intruso' }),
    );
    expect(ok).toBe(false);
    hold.release();
    expect((await a).status).toBe(201);
    expect(await row(CAL, id)).toMatchObject({ summary: 'Dentista', pending_op: null });
  });

  it('una marca sin error abandonada (peticion muerta) deja de bloquear tras IN_FLIGHT_STALE_MS', async () => {
    await seedEvent('e1', { origin: 'app' });
    const dead = newPendingMarker('patch', { summary: 'Muerta' });
    await env.DB.prepare(
      `UPDATE events SET summary = 'Muerta', pending_op = ?1, pending_since = ?2,
         pending_payload = ?3 WHERE id = 'e1'`,
    )
      .bind(dead.op, dead.since, dead.payload)
      .run();
    expect((await send('PATCH', evPath(CAL, 'e1'), { location: 'X' })).status).toBe(409);
    setClock(() => NOW + IN_FLIGHT_STALE_MS + 1000);
    const res = await send('PATCH', evPath(CAL, 'e1'), { location: 'X' });
    expect(res.status).toBe(200);
    // Se fusiono con los campos de la marca abandonada.
    expect(JSON.parse(writes().at(-1)!.body!)).toMatchObject({ summary: 'Muerta', location: 'X' });
    expect(await row(CAL, 'e1')).toMatchObject({ pending_op: null, summary: 'Muerta' });
  });

  it('revertWrite nunca resucita una marca ajena que ya se confirmo (carrera a nivel de D1)', async () => {
    await seedEvent('e1', { origin: 'app' });
    const a = newPendingMarker('patch', { summary: 'A' });
    await env.DB.prepare(
      `UPDATE events SET summary = 'A', pending_op = ?1, pending_since = ?2, pending_payload = ?3`,
    )
      .bind(a.op, a.since, a.payload)
      .run();
    const before = (await loadWriteRow(env.DB, CAL, 'e1'))!;
    // B toma la fila (saltandose la comprobacion de en vuelo de la ruta).
    const b = newPendingMarker('patch', { summary: 'A', location: 'B' });
    expect(await markChange(env.DB, before, { location: 'B' }, b)).toBe(true);
    // A se confirma: solo adopta etag (la fila tiene la marca de B).
    const p = parseGoogleEvent({
      id: 'e1',
      etag: '"555"',
      updated: '2026-10-23T09:00:00.000Z',
      summary: 'A',
      start: { dateTime: '2026-11-05T09:00:00Z' },
      end: { dateTime: '2026-11-05T10:00:00Z' },
    });
    if (p.kind !== 'event') throw new Error('bad');
    await applyGoogleEvent(env.DB, CAL, p.event, { pending: a });
    // B falla: se revierte, pero el pendiente de A (ya confirmado) NO vuelve.
    await revertWrite(env.DB, before, CAL, 'e1', b, { writeError: 'forbidden' });
    expect(await row(CAL, 'e1')).toMatchObject({
      summary: 'A',
      location: null,
      etag: '"555"',
      pending_op: null,
      pending_payload: null,
      pending_since: null,
      write_error: 'forbidden',
    });
  });

  it('403 sobre un patch fallido previo: restaura ese pendiente con write_error forbidden', async () => {
    await seedEvent('e1', { origin: 'app' });
    google.queue.push(gError(503, 'x'), gError(503, 'x'), gError(503, 'x'));
    expect((await send('PATCH', evPath(CAL, 'e1'), { summary: 'A' })).status).toBe(202);
    const pendingA = (await row(CAL, 'e1'))!;
    google.queue.push(gError(403, 'forbidden'));
    expect((await send('PATCH', evPath(CAL, 'e1'), { location: 'B' })).status).toBe(403);
    expect(await row(CAL, 'e1')).toEqual({ ...pendingA, write_error: 'forbidden' });
  });
});

describe('PATCH con 404/410 de Google', () => {
  it('404: quita la fila de D1 pero conserva la meta privada (posible perdida de acceso)', async () => {
    await seedEvent('e1', { origin: 'app' });
    await seedMeta('instance', 'e1', 'NOTA');
    google.store.delete(`${CAL}/e1`);
    const res = await send('PATCH', evPath(CAL, 'e1'), { summary: 'X' });
    expect(res.status).toBe(404);
    expect(await row(CAL, 'e1')).toBeNull();
    expect(await metaCount()).toBe(1);
  });

  it('410: igual que 404', async () => {
    await seedEvent('e1', { origin: 'app' });
    google.put(CAL, { id: 'e1', status: 'cancelled', etag: '"100"' });
    expect((await send('PATCH', evPath(CAL, 'e1'), { summary: 'X' })).status).toBe(404);
    expect(await row(CAL, 'e1')).toBeNull();
  });

  it('con guarda de marca: si otra escritura ya tomo la fila, el 404 no se la borra', async () => {
    await seedEvent('e1', { origin: 'app' });
    google.store.delete(`${CAL}/e1`);
    const later = newPendingMarker('patch', { summary: 'Posterior' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          await env.DB.prepare(
            `UPDATE events SET pending_op = ?1, pending_since = ?2, pending_payload = ?3
             WHERE id = 'e1'`,
          )
            .bind(later.op, later.since, later.payload)
            .run();
        }
        return google.handle(input, init);
      }),
    );
    expect((await send('PATCH', evPath(CAL, 'e1'), { summary: 'X' })).status).toBe(404);
    expect(await row(CAL, 'e1')).toMatchObject({ pending_payload: later.payload });
  });
});

describe('parseInstant en los cambios de hora (Europe/Madrid)', () => {
  const TZ = 'Europe/Madrid';

  it('hora inexistente de primavera (02:30 el 2026-03-29) se mueve tras el salto: 03:30 CEST', () => {
    expect(parseInstant('2026-03-29T02:30', TZ)).toBe('2026-03-29T01:30:00.000Z');
    // Bordes: 01:59 aun es CET; 03:00 ya es CEST.
    expect(parseInstant('2026-03-29T01:59', TZ)).toBe('2026-03-29T00:59:00.000Z');
    expect(parseInstant('2026-03-29T03:00', TZ)).toBe('2026-03-29T01:00:00.000Z');
  });

  it('hora ambigua de otono (02:30 el 2026-10-25) toma la segunda ocurrencia (CET)', () => {
    expect(parseInstant('2026-10-25T02:30', TZ)).toBe('2026-10-25T01:30:00.000Z');
    // La primera ocurrencia (CEST) solo con desfase explicito.
    expect(parseInstant('2026-10-25T02:30+02:00', TZ)).toBe('2026-10-25T00:30:00.000Z');
    expect(parseInstant('2026-10-25T01:59', TZ)).toBe('2026-10-24T23:59:00.000Z');
    expect(parseInstant('2026-10-25T03:00', TZ)).toBe('2026-10-25T02:00:00.000Z');
  });

  it('inicio > fin por el salto de primavera -> 400 con mensaje que explica el salto', async () => {
    const res = await send(
      'POST',
      '/api/agenda',
      createBody({ start: '2026-03-29T02:30', end: '2026-03-29T03:15' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation');
    expect(body.error.message).toContain('2026-03-29T02:30 does not exist in Europe/Madrid');
    // Un fin < inicio normal mantiene el mensaje generico.
    const plain = await send('POST', '/api/agenda', createBody({ end: '2026-11-02T08:00:00Z' }));
    expect(((await plain.json()) as { error: { message: string } }).error.message).toBe(
      'end must not be before start',
    );
  });
});

describe('DELETE confirm_external: contrato', () => {
  it('query y cuerpo distintos, cuerpo invalido o con otras claves -> 400 sin llamar a Google', async () => {
    await seedEvent('e1');
    const cases: [string, string | undefined, string][] = [
      ['?confirm_external=true', JSON.stringify({ confirm_external: false }), 'application/json'],
      ['?confirm_external=false', JSON.stringify({ confirm_external: true }), 'application/json'],
      ['', '{', 'application/json'],
      ['', '{', 'text/plain'],
      ['', '[true]', 'application/json'],
      ['', JSON.stringify({ confirm_external: 'true' }), 'application/json'],
      ['', JSON.stringify({ confirm_external: true, otro: 1 }), 'application/json'],
      ['?confirm_external=1', undefined, 'application/json'],
    ];
    for (const [q, body, type] of cases) {
      const res = await call(evPath(CAL, 'e1', q), {
        method: 'DELETE',
        ip: '203.0.113.90',
        env: OAUTH_ENV,
        headers: { 'Content-Type': type },
        body,
      });
      expect(res.status, `${q} ${body}`).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'validation' } });
    }
    expect(google.requests).toHaveLength(0);
    expect(await row(CAL, 'e1')).toMatchObject({ pending_op: null });
  });

  it('query y cuerpo iguales confirman; {} o ambos false -> 428', async () => {
    await seedEvent('e1');
    await seedEvent('e2');
    const both = await send('DELETE', evPath(CAL, 'e1', '?confirm_external=true'), {
      confirm_external: true,
    });
    expect(both.status).toBe(204);
    expect((await send('DELETE', evPath(CAL, 'e2'), {})).status).toBe(428);
    const bothFalse = await send('DELETE', evPath(CAL, 'e2', '?confirm_external=false'), {
      confirm_external: false,
    });
    expect(bothFalse.status).toBe(428);
  });
});

describe('autenticacion de las rutas de escritura', () => {
  it('sin token o con token malo -> 401 en POST/PATCH/DELETE /api/agenda y GET/PATCH /api/settings', async () => {
    await clearFailures();
    await seedEvent('e1', { origin: 'app' });
    const cases: [string, string, unknown][] = [
      ['POST', '/api/agenda', createBody()],
      ['PATCH', evPath(CAL, 'e1'), { summary: 'X' }],
      ['DELETE', evPath(CAL, 'e1'), undefined],
      ['GET', '/api/settings', undefined],
      ['PATCH', '/api/settings', { app_events_color: '#123456' }],
    ];
    for (const auth of [null, 'Bearer token-incorrecto']) {
      for (const [method, path, body] of cases) {
        const res = await call(path, {
          method,
          ip: '203.0.113.91',
          auth,
          env: OAUTH_ENV,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(res.status, `${method} ${path} ${String(auth)}`).toBe(401);
      }
      await clearFailures();
    }
    expect(google.requests).toHaveLength(0);
    expect(await countEvents()).toBe(1);
    expect(await row(CAL, 'e1')).toMatchObject({ summary: 'Antes', pending_op: null });
    expect(await (await send('GET', '/api/settings')).json()).toEqual({
      app_events_color: null,
      default_write_calendar: null,
    });
  });
});

describe('sync completo con escrituras de T3.7 a mitad de pasada', () => {
  it('la purga no borra la fila pendiente ni la confirmada durante la pasada', async () => {
    await seedEvent('e1', { origin: 'app' });
    await seedEvent('e2', { origin: 'app' });
    const id = await eventIdFor(CLIENT);
    let done = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const isList =
          (init?.method ?? 'GET') === 'GET' &&
          urlOf(input).includes(`/calendars/${encodeURIComponent(CAL)}/events?`);
        if (!isList || done) return google.handle(input, init);
        done = true;
        // La pagina de la pasada completa se calcula ANTES de las escrituras de la app...
        const page = await google.handle(input, init);
        // ...que ocurren mientras el sync la procesa:
        // - alta que queda pendiente (transitorio): no existe en Google ni en la pagina.
        google.queue.push(gError(503, 'x'), gError(503, 'x'), gError(503, 'x'));
        expect((await send('POST', '/api/agenda', createBody())).status).toBe(202);
        // - patch de e2 que queda pendiente (transitorio) con updated viejo.
        google.queue.push(gError(503, 'x'), gError(503, 'x'), gError(503, 'x'));
        expect((await send('PATCH', evPath(CAL, 'e2'), { summary: 'Pend' })).status).toBe(202);
        // - patch confirmado de e1 (updated nuevo): la pagina trae la version vieja.
        expect((await send('PATCH', evPath(CAL, 'e1'), { summary: 'Mid' })).status).toBe(200);
        // e2 desaparece de Google despues de calcular la pagina: tampoco se purga (pendiente).
        google.store.delete(`${CAL}/e2`);
        return page;
      }),
    );
    // Calendario sin syncToken: pasada completa con purga de no vistos.
    const result = await runSync(fullEnv(), { nowMs: NOW });
    expect(done).toBe(true);
    expect(result).toMatchObject({ completed: 2, failed: 0 });
    expect(await row(CAL, id)).toMatchObject({ pending_op: 'insert', local_id: CLIENT });
    expect(await row(CAL, 'e2')).toMatchObject({ pending_op: 'patch', summary: 'Pend' });
    expect(await row(CAL, 'e1')).toMatchObject({ summary: 'Mid', pending_op: null });
    // Una segunda pasada completa (nada en vuelo) sigue sin borrar los pendientes.
    await env.DB.prepare(`UPDATE calendars SET sync_token = NULL, last_full_sync_at = NULL`).run();
    await runSync(fullEnv(), { nowMs: NOW });
    expect(await row(CAL, id)).toMatchObject({ pending_op: 'insert' });
    expect(await row(CAL, 'e2')).toMatchObject({ pending_op: 'patch' });
  });
});
