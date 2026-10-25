import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { loadWriteRow } from '../src/db/eventWrites';
import { acquireLock } from '../src/db/jobLock';
import { writeRuntime } from '../src/google/agendaWrites';
import { eventIdFor } from '../src/google/eventPayload';
import { DEFAULT_STEPS, runScheduled } from '../src/jobs/scheduled';
import {
  PENDING_EXPIRE_MS,
  PENDING_MAX_ATTEMPTS,
  PENDING_MAX_ROWS,
  retryDelayMs,
  retryPendingRow,
  runPendingWrites,
} from '../src/jobs/pendingWrites';
import { SYNC_LOCK_KEY } from '../src/sync/engine';
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
import { call } from './helpers';

const CAL = 'pruebas@group.calendar.google.com';
const CLIENT = '3e1f2a4b-5c6d-4e7f-8a9b-abcdefabcdef';
const MIN = 60_000;

let google: FakeGoogle;
type Row = Record<string, unknown>;

const row = (id: string) =>
  env.DB.prepare('SELECT * FROM events WHERE calendar_id = ?1 AND id = ?2')
    .bind(CAL, id)
    .first<Row>();
const metaTargets = async () =>
  (await env.DB.prepare('SELECT scope, target_id FROM event_meta ORDER BY scope').all()).results;
const writes = () => google.calendarRequests().filter((r) => r.method !== 'GET');
const iso = (ms: number) => new Date(ms).toISOString();

/** Avanza el reloj y ejecuta la cola con ese instante. */
async function runAt(ms: number, budget?: number) {
  setClock(() => ms);
  return runPendingWrites(fullEnv(), { nowMs: ms, budget });
}

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return call(path, {
    method,
    ip: '203.0.113.91',
    env: OAUTH_ENV,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const evPath = (id: string) => `/api/agenda/${encodeURIComponent(CAL)}/${encodeURIComponent(id)}`;
const fail3 = () =>
  google.queue.push(gError(503, 'backendError'), gError(503, 'x'), new Error('network'));

/** Evento confirmado en D1 y Google (mismo etag). */
async function seedEvent(id: string, d1: Row = {}, g: Row = {}) {
  const r: Row = {
    status: 'confirmed',
    summary: 'Antes',
    all_day: 0,
    start_at: '2026-11-05T09:00:00.000Z',
    end_at: '2026-11-05T10:00:00.000Z',
    etag: '"100"',
    updated: '2026-10-01T00:00:00.000Z',
    origin: 'app',
    ...d1,
  };
  const cols = Object.keys(r);
  await env.DB.prepare(
    `INSERT INTO events (calendar_id, id, ${cols.join(', ')})
     VALUES (?1, ?2, ${cols.map((_, i) => `?${i + 3}`).join(', ')})`,
  )
    .bind(CAL, id, ...cols.map((c) => r[c]))
    .run();
  google.put(CAL, {
    kind: 'calendar#event',
    id,
    status: 'confirmed',
    etag: '"100"',
    updated: '2026-10-01T00:00:00.000Z',
    summary: 'Antes',
    start: { dateTime: '2026-11-05T09:00:00Z' },
    end: { dateTime: '2026-11-05T10:00:00Z' },
    ...g,
  });
}

/** Fila con escritura pendiente que ya fallo (como la deja la ruta de T3.7). */
async function seedPending(
  id: string,
  op: 'patch' | 'delete',
  o: {
    fields?: Row;
    attempts?: number;
    sinceMs?: number;
    error?: string | null;
    queuedAt?: string;
    d1?: Row;
  } = {},
) {
  const payload: Row = { v: 1, writeId: `w-${id}`, op };
  if (o.fields) payload.fields = o.fields;
  if (o.queuedAt) payload.queuedAt = o.queuedAt;
  await seedEvent(id, {
    pending_op: op,
    pending_payload: JSON.stringify(payload),
    pending_scope: 'instance',
    pending_attempts: o.attempts ?? 1,
    pending_since: iso(o.sinceMs ?? NOW),
    write_error: o.error === undefined ? 'transient' : o.error,
    ...(op === 'patch' && o.fields?.summary ? { summary: o.fields.summary } : {}),
    ...o.d1,
  });
}

async function seedMeta(scope: 'instance' | 'series', target: string) {
  await env.DB.prepare(
    `INSERT INTO event_meta (calendar_id, scope, target_id, notes, updated_at)
     VALUES (?1, ?2, ?3, 'NOTA', '2026-10-20T00:00:00.000Z')`,
  )
    .bind(CAL, scope, target)
    .run();
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
  writeRuntime.retry = { sleep: async () => {} };
  await connect();
  await addCalendar(CAL, 'owner');
});

afterEach(() => {
  writeRuntime.retry = undefined;
  setClock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LATER = NOW + 10 * MIN;

describe('cola de escrituras pendientes: cada operacion', () => {
  it('insert: repite el POST con el MISMO id/client_id y limpia el pendiente con el updated de Google', async () => {
    fail3();
    const res = await send('POST', '/api/agenda', {
      client_id: CLIENT,
      calendarId: CAL,
      summary: 'Dentista',
      allDay: false,
      start: '2026-11-02T09:00:00Z',
      end: '2026-11-02T10:00:00Z',
    });
    expect(res.status).toBe(202);
    const id = await eventIdFor(CLIENT);
    google.requests = [];

    const r = await runAt(LATER);
    expect(r.counts).toMatchObject({ done: 1 });
    const posts = writes();
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]!.body!) as Row;
    expect(body).toMatchObject({
      id,
      summary: 'Dentista',
      extendedProperties: { private: { organizadorId: CLIENT } },
    });
    expect(await row(id)).toMatchObject({
      pending_op: null,
      write_error: null,
      pending_attempts: 0,
      origin: 'app',
      local_id: CLIENT,
      etag: google.store.get(`${CAL}/${id}`)!.etag,
      updated: iso(NOW),
    });
    // Ya confirmado: la siguiente ejecucion no hace nada.
    google.requests = [];
    await runAt(LATER + 60 * MIN);
    expect(google.calendarRequests()).toHaveLength(0);
  });

  it('insert cuya peticion SI llego a Google: 409 duplicate propio = exito, sin duplicar', async () => {
    fail3();
    await send('POST', '/api/agenda', {
      client_id: CLIENT,
      calendarId: CAL,
      summary: 'Dentista',
      allDay: false,
      start: '2026-11-02T09:00:00Z',
      end: '2026-11-02T10:00:00Z',
    });
    const id = await eventIdFor(CLIENT);
    google.put(CAL, {
      id,
      status: 'confirmed',
      etag: '"777"',
      updated: iso(NOW),
      summary: 'Dentista',
      start: { dateTime: '2026-11-02T09:00:00Z' },
      end: { dateTime: '2026-11-02T10:00:00Z' },
      extendedProperties: { private: { organizadorId: CLIENT } },
    });
    const r = await runAt(LATER);
    expect(r.counts.done).toBe(1);
    expect(await row(id)).toMatchObject({ pending_op: null, etag: '"777"' });
    expect([...google.store.keys()]).toHaveLength(1);
  });

  it('patch: reenvia solo los campos del payload con If-Match y aplica la respuesta', async () => {
    await seedEvent('e1');
    fail3();
    expect((await send('PATCH', evPath('e1'), { summary: 'Nuevo' })).status).toBe(202);
    google.requests = [];
    const r = await runAt(LATER);
    expect(r.counts.done).toBe(1);
    const [p] = writes();
    expect(p!.method).toBe('PATCH');
    expect(p!.headers['if-match']).toBe('"100"');
    expect(JSON.parse(p!.body!)).toEqual({ summary: 'Nuevo' });
    expect(await row('e1')).toMatchObject({
      pending_op: null,
      summary: 'Nuevo',
      etag: google.store.get(`${CAL}/e1`)!.etag,
      updated: iso(NOW),
    });
  });

  it('delete: borra en Google, quita la fila y la meta de instancia (la de serie no)', async () => {
    await seedEvent('e1');
    await seedMeta('instance', 'e1');
    await seedMeta('series', 'serie1');
    fail3();
    expect((await send('DELETE', evPath('e1'))).status).toBe(202);
    expect(await metaTargets()).toHaveLength(2);
    const r = await runAt(LATER);
    expect(r.counts.done).toBe(1);
    expect(writes().at(-1)!.method).toBe('DELETE');
    expect(await row('e1')).toBeNull();
    expect(await metaTargets()).toEqual([{ scope: 'series', target_id: 'serie1' }]);
  });

  it('delete que Google ya no tenia (404) = exito y tambien limpia la meta', async () => {
    await seedPending('e1', 'delete');
    await seedMeta('instance', 'e1');
    google.store.delete(`${CAL}/e1`);
    expect((await runAt(LATER)).counts.done).toBe(1);
    expect(await row('e1')).toBeNull();
    expect(await metaTargets()).toEqual([]);
  });
});

describe('fallos durante el reintento', () => {
  it('transitorio: nueva marca, intento contado, queuedAt conservado y backoff', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' } });
    const before = (await row('e1'))!;
    google.queue.push(gError(500, 'backendError'));
    const r = await runAt(LATER);
    expect(r.counts.retry).toBe(1);
    const after = (await row('e1'))!;
    expect(after).toMatchObject({
      pending_op: 'patch',
      write_error: 'transient',
      pending_attempts: 2,
      pending_since: iso(LATER),
      summary: 'X',
    });
    const p = JSON.parse(after.pending_payload as string) as Row;
    expect(p.writeId).not.toBe(JSON.parse(before.pending_payload as string).writeId);
    expect(p).toMatchObject({ op: 'patch', fields: { summary: 'X' }, queuedAt: iso(NOW) });
    // Sin reintentos en linea: una sola peticion.
    expect(google.calendarRequests()).toHaveLength(1);

    // 10 min despues no toca (2 intentos -> espera 18 min); a los 20 min si.
    google.requests = [];
    await runAt(LATER + 10 * MIN);
    expect(google.calendarRequests()).toHaveLength(0);
    expect((await runAt(LATER + 20 * MIN)).counts.done).toBe(1);
    expect(await row('e1')).toMatchObject({ pending_op: null, summary: 'X' });
  });

  it('429 y 403 de cuota son transitorios', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' } });
    await seedPending('e2', 'patch', { fields: { summary: 'Y' } });
    google.queue.push(gError(429, 'rateLimitExceeded'), gError(403, 'userRateLimitExceeded'));
    expect((await runAt(LATER)).counts.retry).toBe(2);
    for (const id of ['e1', 'e2']) {
      expect(await row(id)).toMatchObject({ write_error: 'transient', pending_attempts: 2 });
    }
    expect((await env.DB.prepare('SELECT access_role FROM calendars').first())!).toEqual({
      access_role: 'owner',
    });
  });

  it('403 de permiso: forbidden definitivo, baja el rol y no se reintenta', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' } });
    google.queue.push(gError(403, 'forbidden'));
    expect((await runAt(LATER)).counts.failed).toBe(1);
    expect(await row('e1')).toMatchObject({
      pending_op: 'patch',
      write_error: 'forbidden',
      summary: 'X',
    });
    expect((await env.DB.prepare('SELECT access_role FROM calendars').first())!).toEqual({
      access_role: 'reader',
    });
    google.requests = [];
    await runAt(LATER + 5 * 3_600_000);
    expect(google.calendarRequests()).toHaveLength(0);
  });

  it('filas con write_error forbidden/conflict/rejected/expired no se tocan', async () => {
    for (const [i, error] of ['forbidden', 'conflict', 'rejected', 'expired'].entries()) {
      await seedPending(`e${i}`, 'patch', { fields: { summary: 'X' }, error });
    }
    const r = await runAt(LATER);
    expect(r.requests).toBe(0);
    expect(google.requests).toHaveLength(0);
  });

  it('delete con 403: la fila vuelve a verse (sin pendiente) con write_error y la meta intacta', async () => {
    await seedPending('e1', 'delete');
    await seedMeta('instance', 'e1');
    google.queue.push(gError(403, 'forbidden'));
    expect((await runAt(LATER)).counts.failed).toBe(1);
    expect(await row('e1')).toMatchObject({
      pending_op: null,
      write_error: 'forbidden',
      summary: 'Antes',
    });
    expect(await metaTargets()).toHaveLength(1);
  });

  it('insert en un calendario que paso a reader: forbidden sin llamar a Google', async () => {
    fail3();
    await send('POST', '/api/agenda', {
      client_id: CLIENT,
      calendarId: CAL,
      summary: 'Dentista',
      allDay: false,
      start: '2026-11-02T09:00:00Z',
      end: '2026-11-02T10:00:00Z',
    });
    await env.DB.prepare("UPDATE calendars SET access_role = 'reader'").run();
    google.requests = [];
    expect((await runAt(LATER)).counts.failed).toBe(1);
    expect(google.calendarRequests()).toHaveLength(0);
    expect(await row(await eventIdFor(CLIENT))).toMatchObject({
      pending_op: 'insert',
      write_error: 'forbidden',
    });
  });

  it('patch con 404 de Google: fuera de D1, la meta se conserva', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' } });
    await seedMeta('instance', 'e1');
    google.store.delete(`${CAL}/e1`);
    expect((await runAt(LATER)).counts.done).toBe(1);
    expect(await row('e1')).toBeNull();
    expect(await metaTargets()).toHaveLength(1);
  });

  it('Google desconectado: not_connected (reintentable) y corta la ejecucion', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' }, sinceMs: NOW - 2 * MIN });
    await seedPending('e2', 'patch', { fields: { summary: 'Y' } });
    await env.DB.prepare('DELETE FROM google_auth').run();
    const r = await runAt(LATER);
    expect(r.counts.retry).toBe(1);
    expect(await row('e1')).toMatchObject({ write_error: 'not_connected', pending_attempts: 2 });
    expect(await row('e2')).toMatchObject({ write_error: 'transient', pending_attempts: 1 });
    expect(google.calendarRequests()).toHaveLength(0);
    // Al reconectar se completa.
    await connect();
    const r2 = await runAt(LATER + 20 * MIN);
    expect(r2.counts.done).toBe(2);
  });
});

describe('412 durante el reintento', () => {
  it('conflicto real en patch: write_error conflict, valores del usuario intactos, sin reintento', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'Mio' } });
    google.put(CAL, { ...google.store.get(`${CAL}/e1`)!, etag: '"300"', summary: 'De otro' });
    const r = await runAt(LATER);
    expect(r.counts.failed).toBe(1);
    expect(await row('e1')).toMatchObject({
      pending_op: 'patch',
      write_error: 'conflict',
      summary: 'Mio',
      etag: '"100"',
    });
    google.requests = [];
    await runAt(LATER + 5 * 3_600_000);
    expect(google.calendarRequests()).toHaveLength(0);
  });

  it('falso conflicto (timeout que Google aplico): 412 + mismos campos = exito', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'Mio', location: 'Sala' } });
    google.put(CAL, {
      ...google.store.get(`${CAL}/e1`)!,
      etag: '"300"',
      summary: 'Mio',
      location: 'Sala',
      updated: iso(NOW),
    });
    const r = await runAt(LATER);
    expect(r.counts.done).toBe(1);
    expect(google.calendarRequests().map((q) => q.method)).toEqual(['PATCH', 'GET']);
    expect(await row('e1')).toMatchObject({
      pending_op: null,
      write_error: null,
      etag: '"300"',
      summary: 'Mio',
      location: 'Sala',
      updated: iso(NOW),
    });
  });

  it('412 y el GET falla de forma transitoria: queda para reintentar', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'Mio' } });
    google.put(CAL, { ...google.store.get(`${CAL}/e1`)!, etag: '"300"' });
    google.queue.push(gError(412, 'conditionNotMet'), gError(503, 'x'));
    expect((await runAt(LATER)).counts.retry).toBe(1);
    expect(await row('e1')).toMatchObject({ pending_op: 'patch', write_error: 'transient' });
  });

  it('delete con el evento cambiado en Google: no se borra y vuelve a verse su version', async () => {
    await seedPending('e1', 'delete');
    await seedMeta('instance', 'e1');
    google.put(CAL, { ...google.store.get(`${CAL}/e1`)!, etag: '"300"', summary: 'Cambiado' });
    expect((await runAt(LATER)).counts.failed).toBe(1);
    expect(await row('e1')).toMatchObject({
      pending_op: null,
      summary: 'Cambiado',
      etag: '"300"',
    });
    expect(await metaTargets()).toHaveLength(1);
  });
});

describe('concurrencia (marca pendiente)', () => {
  it('compare-and-swap: si la fila cambio desde que se leyo, se salta sin llamar a Google', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' } });
    const stale = (await loadWriteRow(env.DB, CAL, 'e1'))!;
    await env.DB.prepare(
      `UPDATE events SET pending_payload = '{"v":1,"writeId":"otra","op":"patch","fields":{"summary":"Z"}}'`,
    ).run();
    setClock(() => LATER);
    expect(await retryPendingRow(fullEnv(), stale)).toBe('skipped');
    expect(google.requests).toHaveLength(0);
  });

  it('una escritura mas nueva que toma la fila durante la llamada no pierde su pendiente', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' } });
    const handle = google.handle.bind(google);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          await env.DB.prepare(
            `UPDATE events SET pending_since = ?1, write_error = 'transient',
               pending_payload = '{"v":1,"writeId":"nueva","op":"patch","fields":{"summary":"Z"}}'`,
          )
            .bind(iso(LATER + 1))
            .run();
        }
        return handle(input, init);
      }),
    );
    expect((await runAt(LATER)).counts.done).toBe(1);
    const r = (await row('e1'))!;
    expect(r.pending_op).toBe('patch');
    expect(JSON.parse(r.pending_payload as string).writeId).toBe('nueva');
    // Adopta el etag confirmado para el If-Match de la escritura nueva.
    expect(r.etag).toBe(google.store.get(`${CAL}/e1`)!.etag);
  });

  it('en vuelo (sin error, < 3 min) no se toca; marca abandonada (> 3 min) si', async () => {
    await seedPending('e1', 'patch', {
      fields: { summary: 'X' },
      error: null,
      attempts: 0,
      sinceMs: LATER - 1 * MIN,
    });
    await seedPending('e2', 'patch', {
      fields: { summary: 'Y' },
      error: null,
      attempts: 0,
      sinceMs: LATER - 4 * MIN,
    });
    const r = await runAt(LATER);
    expect(r.counts.done).toBe(1);
    expect(await row('e1')).toMatchObject({ pending_op: 'patch', write_error: null });
    expect(await row('e2')).toMatchObject({ pending_op: null, summary: 'Y' });
  });

  it('con el lock del sync tomado no hace nada (busy)', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' } });
    expect(await acquireLock(env.DB, SYNC_LOCK_KEY, 5 * MIN, LATER)).not.toBeNull();
    const r = await runAt(LATER);
    expect(r.status).toBe('busy');
    expect(google.requests).toHaveLength(0);
    expect(await row('e1')).toMatchObject({ pending_attempts: 1 });
  });

  it('suelta el lock al terminar (el sync del mismo cron puede correr)', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' } });
    await runAt(LATER);
    expect(await acquireLock(env.DB, SYNC_LOCK_KEY, 5 * MIN, LATER)).not.toBeNull();
  });
});

describe('presupuesto, backoff y expiracion', () => {
  it(`como mucho ${PENDING_MAX_ROWS} filas por ejecucion y el presupuesto las recorta`, async () => {
    for (let i = 0; i < 7; i++) {
      await seedPending(`e${i}`, 'patch', { fields: { summary: `S${i}` }, sinceMs: NOW - i });
    }
    let r = await runAt(LATER, 5);
    expect(r.counts.done).toBe(2);
    expect(r.requests).toBe(5);
    r = await runAt(LATER, 2);
    expect(r.requests).toBe(0);
    expect(google.calendarRequests()).toHaveLength(2);
    r = await runAt(LATER);
    expect(r.counts.done).toBe(PENDING_MAX_ROWS);
    expect(r.requests).toBe(1 + 2 * PENDING_MAX_ROWS);
  });

  it('retryDelayMs: ~10 min, luego exponencial con tope', () => {
    expect(retryDelayMs(0)).toBe(3 * MIN);
    expect(retryDelayMs(1)).toBe(9 * MIN);
    expect(retryDelayMs(2)).toBe(18 * MIN);
    expect(retryDelayMs(20)).toBe(4 * 60 * MIN);
  });

  it('no reintenta antes de ~10 min desde el fallo de la ruta', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' }, sinceMs: LATER - 5 * MIN });
    await runAt(LATER);
    expect(google.requests).toHaveLength(0);
  });

  it('tras 24 h desde el primer intento: expired sin llamar a Google', async () => {
    await seedPending('e1', 'patch', {
      fields: { summary: 'X' },
      attempts: 3,
      sinceMs: LATER - 60 * MIN,
      queuedAt: iso(LATER - PENDING_EXPIRE_MS),
    });
    const r = await runAt(LATER);
    expect(r.counts.expired).toBe(1);
    expect(r.requests).toBe(0);
    expect(google.requests).toHaveLength(0);
    expect(await row('e1')).toMatchObject({
      pending_op: 'patch',
      write_error: 'expired',
      summary: 'X',
    });
  });

  it(`tras ${PENDING_MAX_ATTEMPTS} intentos: expired; un delete expirado vuelve a verse`, async () => {
    await seedPending('e1', 'patch', {
      fields: { summary: 'X' },
      attempts: PENDING_MAX_ATTEMPTS,
      sinceMs: NOW - 5 * 3_600_000,
    });
    await seedPending('e2', 'delete', { queuedAt: iso(NOW - PENDING_EXPIRE_MS) });
    const r = await runAt(LATER);
    expect(r.counts.expired).toBe(2);
    expect(await row('e1')).toMatchObject({ write_error: 'expired', pending_op: 'patch' });
    expect(await row('e2')).toMatchObject({ write_error: 'expired', pending_op: null });
    expect(google.requests).toHaveLength(0);
  });

  it('una escritura que va fallando acaba expirando sin superar el ritmo del cron', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' } });
    const calls: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/calendar/v3/')) {
          calls.push(Date.now());
          return gError(503, 'backendError');
        }
        return google.handle(input, init);
      }),
    );
    let t = NOW;
    let expired = 0;
    for (let i = 0; i < 6 * 30; i++) {
      t += 10 * MIN;
      expired += (await runAt(t)).counts.expired;
    }
    expect(expired).toBe(1);
    expect(calls.length).toBeLessThan(PENDING_MAX_ATTEMPTS);
    expect(await row('e1')).toMatchObject({ write_error: 'expired' });
  });
});

describe('despachador', () => {
  it('pending_writes corre antes del sync y descuenta su presupuesto', async () => {
    await seedPending('e1', 'patch', { fields: { summary: 'X' } });
    const steps = DEFAULT_STEPS.filter((s) => s.name === 'pending_writes' || s.name === 'sync');
    setClock(() => LATER);
    const r = await runScheduled(fullEnv(), LATER, steps);
    expect(r.failed).toEqual([]);
    expect(google.calendarRequests()[0]!.method).toBe('PATCH');
    // El sync corrio despues (lock liberado) y no piso la fila confirmada.
    expect(google.calendarRequests().some((q) => q.method === 'GET')).toBe(true);
    expect(await row('e1')).toMatchObject({ pending_op: null, summary: 'X' });
  });
});
