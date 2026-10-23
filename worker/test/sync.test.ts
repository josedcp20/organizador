import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { toBase64Url } from '../src/crypto/encoding';
import { acquireLock } from '../src/db/jobLock';
import type { Env } from '../src/env';
import {
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_URL,
  loadOAuthConfig,
  saveConnection,
} from '../src/google/oauth';
import { runScheduled } from '../src/jobs/scheduled';
import worker from '../src/index';
import { SYNC_LOCK_KEY, SYNC_LOCK_TTL_MS, backoffMs, runSync } from '../src/sync/engine';
import { syncWindow } from '../src/sync/window';
import { type CallOptions, call as rawCall } from './helpers';

// ---------------------------------------------------------------------------------------------
// Entorno y Google simulado

const rand32 = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const OAUTH_ENV: Partial<Env> = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret-NOT-REAL',
  GOOGLE_REDIRECT_URI: 'https://organizador-api.jose-dcp20.workers.dev/oauth/google/callback',
  TOKEN_ENC_KEY: rand32(),
  OAUTH_STATE_KEY: rand32(),
};
const fullEnv = (): Env => ({ ...env, ...OAUTH_ENV }) as Env;
const call = (path: string, opts: CallOptions = {}) =>
  rawCall(path, { ip: '203.0.113.7', env: OAUTH_ENV, ...opts });

const ACCESS = 'ya29.access-SECRET';
const EVENTS_RE = /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/([^/]+)\/events\?/;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const gError = (status: number, reason: string) =>
  json({ error: { code: status, errors: [{ reason }] } }, status);

type Item = Record<string, unknown>;

/** Google Calendar simulado: estado por calendario, versionado para syncToken. */
class FakeGoogle {
  version = 1;
  pageSize = 2;
  cals = new Map<string, Map<string, Item & { _v: number }>>();
  /** Tokens invalidados -> 410. */
  expired = new Set<string>();
  /** Respuesta forzada por calendario (se consume una vez si `once`). */
  failures = new Map<string, { res: () => Response; once: boolean }>();
  /** Callback antes de responder (para inyectar carreras). */
  onRequest: ((calId: string, q: URLSearchParams) => Promise<void>) | null = null;

  put(calId: string, item: Item) {
    const m = this.cals.get(calId) ?? new Map();
    this.cals.set(calId, m);
    m.set(item.id as string, { ...item, _v: ++this.version });
  }
  cancel(calId: string, id: string) {
    const m = this.cals.get(calId)!;
    const prev = m.get(id)!;
    m.set(id, {
      id,
      status: 'cancelled',
      recurringEventId: prev.recurringEventId,
      _v: ++this.version,
    });
  }
  /** Borrado "duro": desaparece sin dejar cancelled (como un borrado antiguo tras 410). */
  purge(calId: string, id: string) {
    this.cals.get(calId)!.delete(id);
  }

  handle(calId: string, q: URLSearchParams): Response {
    const f = this.failures.get(calId);
    if (f) {
      if (f.once) this.failures.delete(calId);
      return f.res();
    }
    const syncToken = q.get('syncToken');
    if (syncToken && (q.has('timeMin') || q.has('timeMax'))) {
      return gError(400, 'syncTokenWithRequestRestrictions');
    }
    const all = [...(this.cals.get(calId)?.values() ?? [])];
    let list: (Item & { _v: number })[];
    if (syncToken) {
      if (this.expired.has(syncToken)) return gError(410, 'fullSyncRequired');
      const m = /^tok:(.+):(\d+)$/.exec(syncToken);
      if (!m || m[1] !== calId) return gError(400, 'invalid');
      const since = Number(m[2]);
      list = all.filter((i) => i._v > since);
    } else {
      const tMin = q.get('timeMin')!;
      const tMax = q.get('timeMax')!;
      const startOf = (i: Item) => {
        const s = i.start as { date?: string; dateTime?: string } | undefined;
        return s?.dateTime ? new Date(s.dateTime).toISOString() : `${s?.date}T00:00:00.000Z`;
      };
      const endOf = (i: Item) => {
        const s = i.end as { date?: string; dateTime?: string } | undefined;
        return s?.dateTime ? new Date(s.dateTime).toISOString() : `${s?.date}T00:00:00.000Z`;
      };
      list = all.filter((i) => i.status !== 'cancelled' && endOf(i) > tMin && startOf(i) < tMax);
    }
    const pt = q.get('pageToken');
    if (pt && !/^p\d+$/.test(pt)) return gError(400, 'invalid');
    const offset = pt ? Number(pt.slice(1)) : 0;
    const page = list.slice(offset, offset + this.pageSize).map(({ _v, ...rest }) => rest);
    const more = offset + this.pageSize < list.length;
    return json({
      kind: 'calendar#events',
      items: page,
      ...(more
        ? { nextPageToken: `p${offset + this.pageSize}` }
        : { nextSyncToken: `tok:${calId}:${this.version}` }),
    });
  }
}

let google: FakeGoogle;
let requests: { url: string; method: string; calId?: string; q?: URLSearchParams }[];
let tokenResponse: () => Response;
let logSpies: { mock: { calls: unknown[][] } }[];
const loggedText = () => JSON.stringify(logSpies.map((s) => s.mock.calls));

const eventsRequests = () => requests.filter((r) => r.calId !== undefined);

// Reloj fijo: 2026-10-23 12:00 Madrid. Ventana [2026-09-23, 2027-10-23).
const NOW = Date.parse('2026-10-23T10:00:00Z');
const DAY = 86_400_000;

const timed = (id: string, startIso: string, extra: Item = {}): Item => ({
  id,
  status: 'confirmed',
  etag: `"etag-${id}-1"`,
  summary: `Evento ${id}`,
  htmlLink: `https://calendar.example/${id}`,
  updated: '2026-10-01T08:00:00.000Z',
  start: { dateTime: startIso, timeZone: 'Europe/Madrid' },
  end: { dateTime: new Date(Date.parse(startIso) + 3_600_000).toISOString() },
  colorId: '5',
  ...extra,
});
const allDay = (id: string, date: string, extra: Item = {}): Item => {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
  return {
    id,
    status: 'confirmed',
    etag: `"etag-${id}-1"`,
    summary: `Dia ${id}`,
    updated: '2026-10-01T08:00:00.000Z',
    start: { date },
    end: { date: next },
    ...extra,
  };
};

async function connect() {
  const cfg = (await loadOAuthConfig(fullEnv()))!;
  await saveConnection(
    env.DB,
    cfg,
    { access_token: ACCESS, expires_in: 3600, refresh_token: '1//refresh-SECRET' },
    [...GOOGLE_SCOPES],
  );
}

async function addCalendar(id: string, extra: { enabled?: number; removed_at?: string } = {}) {
  await env.DB.prepare(
    `INSERT INTO calendars (id, summary, color, enabled, access_role, removed_at)
     VALUES (?1, ?2, '#1a73e8', ?3, 'owner', ?4)`,
  )
    .bind(id, `Cal ${id}`, extra.enabled ?? 1, extra.removed_at ?? null)
    .run();
}

type Row = Record<string, unknown>;
const events = async (calId?: string) =>
  (
    await env.DB.prepare(
      `SELECT * FROM events ${calId ? 'WHERE calendar_id = ?1' : ''} ORDER BY calendar_id, id`,
    )
      .bind(...(calId ? [calId] : []))
      .all<Row>()
  ).results;
const ids = async (calId: string) => (await events(calId)).map((r) => r.id);
const calRow = async (id: string) =>
  (await env.DB.prepare('SELECT * FROM calendars WHERE id = ?1').bind(id).first<Row>())!;

const sync = (opts: { maxRequests?: number; nowMs?: number } = {}) =>
  runSync(fullEnv(), { nowMs: opts.nowMs ?? NOW, maxRequests: opts.maxRequests });

beforeEach(async () => {
  for (const t of ['events', 'event_meta', 'calendars', 'google_auth', 'job_state']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  setClock(() => NOW);
  google = new FakeGoogle();
  requests = [];
  tokenResponse = () =>
    json({ access_token: ACCESS, expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      if (url === GOOGLE_TOKEN_URL) {
        requests.push({ url, method });
        return tokenResponse();
      }
      const m = EVENTS_RE.exec(url);
      if (m) {
        const calId = decodeURIComponent(m[1]!);
        const q = new URL(url).searchParams;
        requests.push({ url, method, calId, q });
        const auth = new Headers(init?.headers).get('Authorization');
        if (auth !== `Bearer ${ACCESS}`) return gError(401, 'authError');
        if (google.onRequest) await google.onRequest(calId, q);
        return google.handle(calId, q);
      }
      requests.push({ url, method });
      throw new Error(`fetch inesperado a ${url}`);
    }),
  );
  logSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  setClock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe('syncWindow', () => {
  it('1 mes atras y 12 adelante en Madrid', () => {
    expect(syncWindow(NOW)).toEqual({
      today: '2026-10-23',
      startDate: '2026-09-23',
      endDate: '2027-10-23',
      timeMin: '2026-09-22T22:00:00.000Z',
      timeMax: '2027-10-22T22:00:00.000Z',
    });
  });

  it('usa el dia de Madrid, no el UTC', () => {
    expect(syncWindow(Date.parse('2026-10-22T22:30:00Z')).today).toBe('2026-10-23');
  });
});

describe('sync completo inicial', () => {
  beforeEach(async () => {
    await connect();
    await addCalendar('a@x');
  });

  it('pagina, guarda eventos y nextSyncToken con los parametros del spike', async () => {
    for (let i = 1; i <= 5; i++) google.put('a@x', timed(`e${i}`, `2026-11-0${i}T09:00:00+01:00`));
    const r = await sync();
    expect(r).toMatchObject({ status: 'ok', calendars: 1, completed: 1, failed: 0, requests: 3 });
    expect(r.upserted).toBe(5);
    expect(await ids('a@x')).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);

    const reqs = eventsRequests();
    expect(reqs).toHaveLength(3);
    for (const q of reqs.map((x) => x.q!)) {
      expect(q.get('singleEvents')).toBe('true');
      expect(q.get('showDeleted')).toBe('true');
      expect(q.get('maxResults')).toBe('250');
      expect(q.get('timeMin')).toBe('2026-09-22T22:00:00.000Z');
      expect(q.get('timeMax')).toBe('2027-10-22T22:00:00.000Z');
      expect(q.has('syncToken')).toBe(false);
    }
    expect(reqs.map((x) => x.q!.get('pageToken'))).toEqual([null, 'p2', 'p4']);

    const c = await calRow('a@x');
    expect(c.sync_token).toBe(`tok:a@x:${google.version}`);
    expect(c.sync_cursor).toBeNull();
    expect(c.last_synced_at).toBe(new Date(NOW).toISOString());
    expect(c.last_full_sync_at).toBe(new Date(NOW).toISOString());
    expect(c.last_sync_error).toBeNull();
  });

  it('mapea campos: con hora a UTC, dia completo, etag del body, recurrentes, sin colorId', async () => {
    google.put(
      'a@x',
      timed('t1', '2026-11-10T10:30:00+01:00', {
        location: 'Sala 1',
        description: 'Descripcion de Google',
        recurringEventId: 'serie1',
        originalStartTime: { dateTime: '2026-11-10T10:30:00+01:00' },
        etag: '"body-etag"',
        status: 'tentative',
      }),
    );
    google.put('a@x', allDay('d1', '2026-12-25'));
    await sync();
    const [d1, t1] = await events('a@x');
    expect(t1).toMatchObject({
      id: 't1',
      status: 'tentative',
      all_day: 0,
      start_at: '2026-11-10T09:30:00.000Z',
      end_at: '2026-11-10T10:30:00.000Z',
      start_date: null,
      summary: 'Evento t1',
      location: 'Sala 1',
      description: 'Descripcion de Google',
      recurring_event_id: 'serie1',
      original_start: '2026-11-10T09:30:00.000Z',
      etag: '"body-etag"',
      origin: 'google',
      pending_op: null,
    });
    expect(d1).toMatchObject({
      id: 'd1',
      all_day: 1,
      start_date: '2026-12-25',
      end_date: '2026-12-26',
      start_at: null,
    });
    // Ninguna columna guarda el colorId de Google.
    expect(JSON.stringify(t1)).not.toContain('"5"');
  });

  it('detecta origin=app por extendedProperties.private.organizadorId sin romper el indice unico', async () => {
    google.put(
      'a@x',
      timed('app1', '2026-11-01T09:00:00Z', {
        extendedProperties: { private: { organizadorId: 'uuid-1' } },
      }),
    );
    // Copia anomala con el mismo organizadorId y otro id.
    google.put(
      'a@x',
      timed('copia', '2026-11-02T09:00:00Z', {
        extendedProperties: { private: { organizadorId: 'uuid-1' } },
      }),
    );
    const r = await sync();
    expect(r.failed).toBe(0);
    const rows = await events('a@x');
    expect(rows.map((x) => [x.id, x.origin, x.local_id])).toEqual([
      ['app1', 'app', 'uuid-1'],
      ['copia', 'app', null],
    ]);
  });

  it('no guarda instancias fuera del horizonte ni eventos nuevos anteriores a la ventana', async () => {
    google.put('a@x', timed('lejano', '2027-10-23T09:00:00Z')); // >= timeMax
    google.put('a@x', allDay('lejano-dia', '2027-10-23'));
    // Empieza antes de la ventana pero termina dentro (Google lo devuelve por timeMin = fin).
    google.put('a@x', {
      ...timed('largo', '2026-09-01T09:00:00Z'),
      end: { dateTime: '2026-10-30T09:00:00Z' },
    });
    google.put('a@x', timed('dentro', '2027-10-22T21:59:00Z'));
    await sync();
    expect(await ids('a@x')).toEqual(['dentro']);
  });
});

describe('sync incremental', () => {
  beforeEach(async () => {
    await connect();
    await addCalendar('a@x');
    google.put('a@x', timed('e1', '2026-11-01T09:00:00Z'));
    google.put('a@x', timed('e2', '2026-11-02T09:00:00Z'));
    google.put('a@x', timed('e3', '2026-11-03T09:00:00Z'));
    await sync();
    requests = [];
  });

  it('usa SOLO syncToken (sin timeMin/timeMax) y aplica cambios', async () => {
    google.put('a@x', timed('e1', '2026-11-01T09:00:00Z', { summary: 'Cambiado', etag: '"v2"' }));
    google.put('a@x', timed('e4', '2026-11-04T09:00:00Z'));
    const r = await sync({ nowMs: NOW + 600_000 });
    expect(r).toMatchObject({ status: 'ok', completed: 1, requests: 1 });
    const [req] = eventsRequests();
    expect(req!.q!.get('syncToken')).toMatch(/^tok:a@x:/);
    expect(req!.q!.has('timeMin')).toBe(false);
    expect(req!.q!.has('timeMax')).toBe(false);
    expect(req!.q!.get('singleEvents')).toBe('true');
    expect(req!.q!.get('showDeleted')).toBe('true');
    const rows = await events('a@x');
    expect(rows.find((x) => x.id === 'e1')).toMatchObject({ summary: 'Cambiado', etag: '"v2"' });
    expect(rows.map((x) => x.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect((await calRow('a@x')).sync_token).toBe(`tok:a@x:${google.version}`);
  });

  it('cancelado -> borra la fila pero conserva event_meta (notas privadas)', async () => {
    await env.DB.prepare(
      `INSERT INTO event_meta (calendar_id, scope, target_id, notes, remind, updated_at)
       VALUES ('a@x', 'instance', 'e2', 'nota privada', 1, '2026-10-01T00:00:00Z')`,
    ).run();
    google.cancel('a@x', 'e2');
    const r = await sync({ nowMs: NOW + 600_000 });
    expect(r.deleted).toBe(1);
    expect(await ids('a@x')).toEqual(['e1', 'e3']);
    const meta = await env.DB.prepare("SELECT notes FROM event_meta WHERE target_id = 'e2'").first<{
      notes: string;
    }>();
    expect(meta?.notes).toBe('nota privada');

    // Cancelado transitorio: el evento vuelve con el mismo id y la meta sigue enlazada.
    google.put('a@x', timed('e2', '2026-11-02T09:00:00Z', { etag: '"v3"' }));
    await sync({ nowMs: NOW + 1_200_000 });
    expect(await ids('a@x')).toEqual(['e1', 'e2', 'e3']);
  });

  it('sin cambios de etag no reescribe la fila', async () => {
    const before = await events('a@x');
    google.put('a@x', timed('e1', '2026-11-01T09:00:00Z')); // mismo etag
    const r = await sync({ nowMs: NOW + 600_000 });
    expect(r.upserted).toBe(0);
    expect(await events('a@x')).toEqual(before);
  });

  it('evento movido fuera del horizonte -> se borra su fila', async () => {
    google.put('a@x', timed('e3', '2028-01-01T09:00:00Z', { etag: '"v2"' }));
    await sync({ nowMs: NOW + 600_000 });
    expect(await ids('a@x')).toEqual(['e1', 'e2']);
  });

  it('no sobrescribe ni borra filas con pending_op', async () => {
    await env.DB.prepare(
      "UPDATE events SET pending_op = 'patch', summary = 'Local' WHERE id IN ('e1', 'e2')",
    ).run();
    google.put('a@x', timed('e1', '2026-11-01T09:00:00Z', { summary: 'Google', etag: '"v2"' }));
    google.cancel('a@x', 'e2');
    await sync({ nowMs: NOW + 600_000 });
    const rows = await events('a@x');
    expect(rows.map((x) => [x.id, x.summary])).toEqual([
      ['e1', 'Local'],
      ['e2', 'Local'],
      ['e3', 'Evento e3'],
    ]);
  });

  it('el eco de un evento creado por la app actualiza su fila sin duplicarla', async () => {
    await env.DB.prepare(
      `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at, origin, local_id, etag)
       VALUES ('a@x', 'appid1', 'confirmed', 'Creado', 0, '2026-11-05T09:00:00.000Z',
               '2026-11-05T10:00:00.000Z', 'app', 'uuid-9', '"app-1"')`,
    ).run();
    google.put(
      'a@x',
      timed('appid1', '2026-11-05T09:00:00Z', {
        summary: 'Creado',
        etag: '"app-2"',
        extendedProperties: { private: { organizadorId: 'uuid-9' } },
      }),
    );
    await sync({ nowMs: NOW + 600_000 });
    const rows = (await events('a@x')).filter((x) => x.id === 'appid1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'app', local_id: 'uuid-9', etag: '"app-2"' });
  });

  it('pasada completa diaria: al cambiar el dia vuelve a pedir la ventana', async () => {
    const tomorrow = NOW + DAY;
    setClock(() => tomorrow);
    const r = await sync({ nowMs: tomorrow });
    expect(r.completed).toBe(1);
    const [req] = eventsRequests();
    expect(req!.q!.get('timeMin')).toBe('2026-09-23T22:00:00.000Z');
    expect(req!.q!.has('syncToken')).toBe(false);
    // Y el mismo dia, la siguiente ya es incremental.
    requests = [];
    await sync({ nowMs: tomorrow + 600_000 });
    expect(eventsRequests()[0]!.q!.has('syncToken')).toBe(true);
  });
});

describe('eventos congelados (anteriores a la ventana)', () => {
  beforeEach(async () => {
    await connect();
    await addCalendar('a@x');
    // Copiados hace tiempo: inicio anterior a hoy - 1 mes.
    await env.DB.prepare(
      `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at, start_date, end_date, etag, updated)
       VALUES ('a@x', 'viejo', 'confirmed', 'Viejo', 0, '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', NULL, NULL, '"o1"', '2026-07-01T00:00:00.000Z'),
              ('a@x', 'viejo-dia', 'confirmed', 'Viejo dia', 1, NULL, NULL, '2026-09-22', '2026-09-23', '"o2"', '2026-07-01T00:00:00.000Z')`,
    ).run();
  });

  it('la pasada completa no los borra aunque Google ya no los devuelva', async () => {
    google.put('a@x', timed('nuevo', '2026-11-01T09:00:00Z'));
    await sync();
    expect(await ids('a@x')).toEqual(['nuevo', 'viejo', 'viejo-dia']);
  });

  it('el incremental no los actualiza ni los borra', async () => {
    await sync();
    google.put('a@x', timed('viejo', '2026-08-01T09:00:00Z', { summary: 'Editado', etag: '"x"' }));
    google.cancel('a@x', 'viejo');
    google.put('a@x', allDay('viejo-dia', '2026-09-22', { summary: 'Editado', etag: '"y"' }));
    await sync({ nowMs: NOW + 600_000 });
    const rows = await events('a@x');
    expect(rows.find((x) => x.id === 'viejo')).toMatchObject({ summary: 'Viejo', etag: '"o1"' });
    expect(rows.find((x) => x.id === 'viejo-dia')).toMatchObject({ summary: 'Viejo dia' });
  });
});

describe('410 / 400 invalid -> resync completo', () => {
  beforeEach(async () => {
    await connect();
    await addCalendar('a@x');
    google.put('a@x', timed('e1', '2026-11-01T09:00:00Z'));
    google.put('a@x', timed('e2', '2026-11-02T09:00:00Z'));
    await env.DB.prepare(
      `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at, etag, updated)
       VALUES ('a@x', 'viejo', 'confirmed', 'Viejo', 0, '2026-08-01T09:00:00.000Z', '2026-08-01T10:00:00.000Z', '"o"', '2026-07-01T00:00:00.000Z')`,
    ).run();
    await sync();
    requests = [];
  });

  it.each(['410', '400 invalid'] as const)(
    '%s: descarta el token, rehace la ventana y purga borrados perdidos',
    async (kind) => {
      const tok = (await calRow('a@x')).sync_token as string;
      if (kind === '410') google.expired.add(tok);
      else
        await env.DB.prepare("UPDATE calendars SET sync_token = 'basura' WHERE id = 'a@x'").run();
      // Borrado en Google cuyo "cancelled" ya no llegara.
      google.purge('a@x', 'e2');
      google.put('a@x', timed('e3', '2026-11-03T09:00:00Z'));

      const r = await sync({ nowMs: NOW + 600_000 });
      expect(r).toMatchObject({ status: 'ok', completed: 1, failed: 0 });
      const reqs = eventsRequests();
      expect(reqs[0]!.q!.has('syncToken')).toBe(true);
      expect(reqs[1]!.q!.has('syncToken')).toBe(false);
      expect(reqs[1]!.q!.get('timeMin')).toBe('2026-09-22T22:00:00.000Z');
      // e2 purgado; congelado conservado.
      expect(await ids('a@x')).toEqual(['e1', 'e3', 'viejo']);
      expect((await calRow('a@x')).sync_token).toBe(`tok:a@x:${google.version}`);
    },
  );

  it('la purga respeta filas pendientes y filas escritas por la app tras empezar la pasada', async () => {
    google.expired.add((await calRow('a@x')).sync_token as string);
    await env.DB.prepare(
      `INSERT INTO events (calendar_id, id, status, all_day, start_at, end_at, origin, pending_op, updated)
       VALUES ('a@x', 'pend', 'confirmed', 0, '2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z', 'app', 'insert', NULL),
              ('a@x', 'reciente', 'confirmed', 0, '2026-11-10T09:00:00.000Z', '2026-11-10T10:00:00.000Z', 'app', NULL, ?1)`,
    )
      .bind(new Date(NOW + 700_000).toISOString())
      .run();
    await sync({ nowMs: NOW + 600_000 });
    expect(await ids('a@x')).toEqual(['e1', 'e2', 'pend', 'reciente', 'viejo']);
  });
});

describe('presupuesto y reanudacion', () => {
  beforeEach(async () => {
    await connect();
    await addCalendar('a@x');
    for (let i = 1; i <= 7; i++) google.put('a@x', timed(`e${i}`, `2026-11-0${i}T09:00:00Z`));
  });

  it('corta por presupuesto, guarda el cursor y la siguiente ejecucion continua', async () => {
    const r1 = await sync({ maxRequests: 2 });
    expect(r1).toMatchObject({ completed: 0, partial: 1, requests: 2 });
    let c = await calRow('a@x');
    expect(c.sync_token).toBeNull(); // el token solo se escribe en la ultima pagina
    expect(JSON.parse(c.sync_cursor as string)).toMatchObject({ phase: 'full', pageToken: 'p4' });
    expect(await ids('a@x')).toEqual(['e1', 'e2', 'e3', 'e4']);

    requests = [];
    const r2 = await sync({ maxRequests: 10, nowMs: NOW + 600_000 });
    expect(r2).toMatchObject({ completed: 1, partial: 0, requests: 2 });
    const reqs = eventsRequests();
    expect(reqs.map((x) => x.q!.get('pageToken'))).toEqual(['p4', 'p6']);
    // Misma ventana que al empezar la pasada.
    expect(reqs[0]!.q!.get('timeMin')).toBe('2026-09-22T22:00:00.000Z');
    c = await calRow('a@x');
    expect(c.sync_cursor).toBeNull();
    expect(c.sync_token).toBe(`tok:a@x:${google.version}`);
    expect(c.last_full_sync_at).toBe(new Date(NOW).toISOString());
    expect(await ids('a@x')).toHaveLength(7);
  });

  it('un incremental cortado conserva el token anterior hasta la ultima pagina', async () => {
    await sync();
    const tok = (await calRow('a@x')).sync_token;
    for (let i = 1; i <= 5; i++) {
      google.put('a@x', timed(`e${i}`, `2026-11-0${i}T09:00:00Z`, { etag: '"v2"' }));
    }
    const r = await sync({ maxRequests: 1, nowMs: NOW + 600_000 });
    expect(r.partial).toBe(1);
    const c = await calRow('a@x');
    expect(c.sync_token).toBe(tok);
    expect(JSON.parse(c.sync_cursor as string)).toMatchObject({ phase: 'incremental' });
    await sync({ nowMs: NOW + 1_200_000 });
    expect((await calRow('a@x')).sync_cursor).toBeNull();
    expect((await calRow('a@x')).sync_token).toBe(`tok:a@x:${google.version}`);
  });

  it('pageToken caducado al reanudar -> reinicia la pasada completa', async () => {
    await sync({ maxRequests: 1 });
    await env.DB.prepare(
      `UPDATE calendars SET sync_cursor = json_set(sync_cursor, '$.pageToken', 'caducado')`,
    ).run();
    requests = [];
    const r = await sync({ nowMs: NOW + 600_000 });
    expect(r.completed).toBe(1);
    expect(eventsRequests()[1]!.q!.has('pageToken')).toBe(false);
    expect(await ids('a@x')).toHaveLength(7);
  });

  it('una pasada completa a medias de otro dia se descarta y empieza con la ventana de hoy', async () => {
    await sync({ maxRequests: 1 });
    requests = [];
    const tomorrow = NOW + DAY;
    const r = await sync({ nowMs: tomorrow });
    expect(r.completed).toBe(1);
    const reqs = eventsRequests();
    expect(reqs[0]!.q!.has('pageToken')).toBe(false);
    expect(reqs[0]!.q!.get('timeMin')).toBe('2026-09-23T22:00:00.000Z');
    expect((await calRow('a@x')).last_full_sync_at).toBe(new Date(tomorrow).toISOString());
  });

  it('presupuesto 0 no llama a Google', async () => {
    const r = await sync({ maxRequests: 0 });
    expect(r.partial).toBe(1);
    expect(eventsRequests()).toHaveLength(0);
  });

  it('los incrementales (baratos) van antes que las pasadas completas', async () => {
    await addCalendar('b@x');
    google.put('b@x', timed('b1', '2026-11-01T09:00:00Z'));
    await sync(); // ambos completos
    await env.DB.prepare("UPDATE calendars SET last_full_sync_at = NULL WHERE id = 'a@x'").run();
    await env.DB.prepare(
      "UPDATE calendars SET last_synced_at = '2000-01-01' WHERE id = 'a@x'",
    ).run();
    requests = [];
    await sync({ maxRequests: 1, nowMs: NOW + 600_000 });
    expect(eventsRequests().map((x) => x.calId)).toEqual(['b@x']);
  });
});

describe('aislamiento de errores', () => {
  beforeEach(async () => {
    await connect();
    await addCalendar('a@x');
    await addCalendar('b@x');
    await addCalendar('c@x');
    for (const c of ['a@x', 'b@x', 'c@x']) google.put(c, timed(`${c}-1`, '2026-11-01T09:00:00Z'));
  });

  it.each([
    [500, 'backendError', 'google_5xx'],
    [404, 'notFound', 'not_found'],
    [403, 'forbidden', 'forbidden'],
  ])(
    '%i en un calendario no para el resto y queda en last_sync_error',
    async (st, reason, code) => {
      google.failures.set('b@x', { res: () => gError(st, reason), once: false });
      const r = await sync();
      expect(r).toMatchObject({ status: 'ok', completed: 2, failed: 1 });
      expect(await ids('a@x')).toHaveLength(1);
      expect(await ids('c@x')).toHaveLength(1);
      const b = await calRow('b@x');
      expect(b.last_sync_error).toBe(code);
      expect(b.last_sync_error_at).toBe(new Date(NOW).toISOString());
      expect(b.sync_failures).toBe(1);
      expect(Date.parse(b.sync_backoff_until as string)).toBeGreaterThan(NOW);
      // El codigo no contiene datos sensibles.
      expect(String(b.last_sync_error)).toMatch(/^[a-z_0-9]+$/);
    },
  );

  it('backoff: no se reintenta antes de tiempo; al recuperarse se limpia el error', async () => {
    google.failures.set('b@x', { res: () => gError(500, 'backendError'), once: true });
    await sync();
    requests = [];
    await sync({ nowMs: NOW + 60_000 });
    expect(eventsRequests().map((x) => x.calId)).not.toContain('b@x');
    const until = Date.parse((await calRow('b@x')).sync_backoff_until as string);
    requests = [];
    const r = await sync({ nowMs: until + 1 });
    expect(eventsRequests().map((x) => x.calId)).toContain('b@x');
    expect(r.failed).toBe(0);
    const b = await calRow('b@x');
    expect(b).toMatchObject({ last_sync_error: null, sync_failures: 0, sync_backoff_until: null });
  });

  it('403 rateLimitExceeded -> backoff y corta la ejecucion (cuota por usuario)', async () => {
    // Orden de proceso: a, b, c (mismo last_synced_at; desempate por id).
    google.failures.set('b@x', { res: () => gError(403, 'rateLimitExceeded'), once: false });
    const r = await sync();
    expect(r).toMatchObject({ completed: 1, failed: 1 });
    expect(eventsRequests().map((x) => x.calId)).toEqual(['a@x', 'b@x']);
    expect((await calRow('b@x')).last_sync_error).toBe('rate_limited');
  });

  it('429 tambien es cuota', async () => {
    google.failures.set('a@x', { res: () => gError(429, 'rateLimitExceeded'), once: false });
    const r = await sync();
    expect(r.failed).toBe(1);
    expect((await calRow('a@x')).last_sync_error).toBe('rate_limited');
  });

  it('respuesta sin nextPageToken ni nextSyncToken -> bad_response', async () => {
    google.failures.set('a@x', { res: () => json({ items: [] }), once: true });
    const r = await sync();
    expect(r.failed).toBe(1);
    expect((await calRow('a@x')).last_sync_error).toBe('bad_response');
  });

  it('backoff exponencial acotado', () => {
    expect(backoffMs(1, 0)).toBe(10 * 60_000);
    expect(backoffMs(2, 0)).toBe(20 * 60_000);
    expect(backoffMs(20, 0)).toBe(6 * 3600_000);
    expect(backoffMs(1, 1)).toBe(12 * 60_000);
  });

  it('401 -> olvida el access token cacheado y corta, sin marcar calendarios', async () => {
    google.failures.set('a@x', { res: () => gError(401, 'authError'), once: false });
    const r = await sync();
    expect(r.status).toBe('auth_rejected');
    const auth = await env.DB.prepare('SELECT access_token FROM google_auth').first<Row>();
    expect(auth!.access_token).toBeNull();
    expect(eventsRequests()).toHaveLength(1);
    expect((await calRow('a@x')).last_sync_error).toBeNull();
  });
});

describe('Google desconectado / calendarios no sincronizables', () => {
  it('sin conexion: no llama a nada y no falla', async () => {
    await addCalendar('a@x');
    const r = await sync();
    expect(r.status).toBe('not_connected');
    expect(requests).toHaveLength(0);
    expect((await calRow('a@x')).last_sync_error).toBeNull();
  });

  it('invalid_grant al renovar: no sincroniza, no lanza, marca Google desconectado', async () => {
    await connect();
    await addCalendar('a@x');
    await env.DB.prepare('UPDATE google_auth SET access_token_expires_at = ?1')
      .bind(new Date(NOW - 1000).toISOString())
      .run();
    tokenResponse = () => json({ error: 'invalid_grant' }, 400);
    const r = await sync();
    expect(r.status).toBe('not_connected');
    expect(eventsRequests()).toHaveLength(0);
    const auth = await env.DB.prepare('SELECT last_error FROM google_auth').first<Row>();
    expect(auth!.last_error).toBe('invalid_grant');
  });

  it('ocultos (enabled=0) y desaparecidos (removed_at) no se sincronizan', async () => {
    await connect();
    await addCalendar('oculto@x', { enabled: 0 });
    await addCalendar('ido@x', { removed_at: '2026-10-01T00:00:00Z' });
    await addCalendar('si@x');
    for (const c of ['oculto@x', 'ido@x', 'si@x'])
      google.put(c, timed(`${c}1`, '2026-11-01T09:00:00Z'));
    const r = await sync();
    expect(r.calendars).toBe(1);
    expect(eventsRequests().map((x) => x.calId)).toEqual(['si@x']);
  });

  it('sin calendarios no pide ni access token', async () => {
    await connect();
    const r = await sync();
    expect(r).toMatchObject({ status: 'ok', calendars: 0 });
    expect(requests).toHaveLength(0);
  });
});

describe('no solape (lock)', () => {
  beforeEach(async () => {
    await connect();
    await addCalendar('a@x');
    google.put('a@x', timed('e1', '2026-11-01T09:00:00Z'));
  });

  it('con el lock tomado por otra ejecucion -> busy sin llamar a Google', async () => {
    expect(await acquireLock(env.DB, SYNC_LOCK_KEY, SYNC_LOCK_TTL_MS, NOW)).not.toBeNull();
    const r = await sync();
    expect(r.status).toBe('busy');
    expect(requests).toHaveLength(0);
  });

  it('un lock caducado (dueno muerto) se puede tomar', async () => {
    await acquireLock(env.DB, SYNC_LOCK_KEY, SYNC_LOCK_TTL_MS, NOW - SYNC_LOCK_TTL_MS - 1000);
    const r = await sync();
    expect(r.status).toBe('ok');
    expect(r.completed).toBe(1);
  });

  it('dos ejecuciones concurrentes: solo una sincroniza', async () => {
    const [r1, r2] = await Promise.all([sync(), sync()]);
    expect([r1.status, r2.status].sort()).toEqual(['busy', 'ok']);
    expect(eventsRequests()).toHaveLength(1);
  });

  it('libera el lock al terminar', async () => {
    await sync();
    const row = await env.DB.prepare("SELECT 1 FROM job_state WHERE key = 'sync_lock'").first();
    expect(row).toBeNull();
  });

  it('si otro le quita el lock a mitad, no escribe nada mas', async () => {
    for (let i = 2; i <= 5; i++) google.put('a@x', timed(`e${i}`, `2026-11-0${i}T09:00:00Z`));
    google.onRequest = async (_cal, q) => {
      if (q.get('pageToken') === 'p2') {
        await env.DB.prepare("UPDATE job_state SET value = 'otro' WHERE key = 'sync_lock'").run();
      }
    };
    const r = await sync();
    expect(r.completed).toBe(0);
    expect(await ids('a@x')).toEqual(['e1', 'e2']); // solo la primera pagina
    expect(JSON.parse((await calRow('a@x')).sync_cursor as string).pageToken).toBe('p2');
    // No libero el lock ajeno.
    const row = await env.DB.prepare(
      "SELECT value FROM job_state WHERE key = 'sync_lock'",
    ).first<Row>();
    expect(row!.value).toBe('otro');
  });
});

describe('solo lectura hacia Google', () => {
  it('todas las peticiones a googleapis son GET de calendars/{id}/events', async () => {
    await connect();
    await addCalendar('a@x');
    await addCalendar('es.spain#holiday@group.v.calendar.google.com');
    google.put('a@x', timed('e1', '2026-11-01T09:00:00Z'));
    google.put('es.spain#holiday@group.v.calendar.google.com', allDay('h1', '2026-12-08'));
    await sync();
    google.cancel('a@x', 'e1');
    google.expired.add((await calRow('a@x')).sync_token as string);
    await sync({ nowMs: NOW + 600_000 });
    const gapi = requests.filter((r) => r.url.includes('googleapis.com/calendar'));
    expect(gapi.length).toBeGreaterThan(2);
    for (const r of gapi) {
      expect(r.method).toBe('GET');
      expect(r.url).toMatch(EVENTS_RE);
    }
    // El calendarId con '#' y '@' va codificado en un unico segmento.
    expect(gapi.some((r) => r.url.includes('es.spain%23holiday%40group'))).toBe(true);
    expect(await ids('es.spain#holiday@group.v.calendar.google.com')).toEqual(['h1']);
  });
});

describe('cron (jobs/scheduled.ts) y POST /api/sync', () => {
  it('runScheduled ejecuta los pasos en orden y aisla fallos', async () => {
    const order: string[] = [];
    const r = await runScheduled(fullEnv(), NOW, [
      { name: 'uno', run: async () => void order.push('uno') },
      {
        name: 'roto',
        run: async () => {
          order.push('roto');
          throw new Error('secreto-que-no-debe-loguearse');
        },
      },
      { name: 'tres', run: async () => void order.push('tres') },
    ]);
    expect(order).toEqual(['uno', 'roto', 'tres']);
    expect(r.failed).toEqual(['roto']);
    const logged = loggedText();
    expect(logged).not.toContain('secreto-que-no-debe-loguearse');
  });

  it('el handler scheduled sincroniza (pasos por defecto)', async () => {
    await connect();
    await addCalendar('a@x');
    google.put('a@x', timed('e1', '2026-11-01T09:00:00Z'));
    await worker.scheduled(
      { scheduledTime: NOW, cron: '*/10 * * * *', noRetry() {} } as ScheduledController,
      fullEnv(),
      {} as ExecutionContext,
    );
    expect(await ids('a@x')).toEqual(['e1']);
  });

  it('el cron sin Google conectado no lanza', async () => {
    await addCalendar('a@x');
    await expect(
      worker.scheduled(
        { scheduledTime: NOW, cron: '*/10 * * * *', noRetry() {} } as ScheduledController,
        fullEnv(),
        {} as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
  });

  it('los logs no contienen tokens, ids de calendario ni datos de eventos', async () => {
    await connect();
    await addCalendar('privado@gmail.com');
    google.put('privado@gmail.com', timed('e1', '2026-11-01T09:00:00Z', { summary: 'Medico' }));
    google.failures.set('privado@gmail.com', { res: () => gError(500, 'x'), once: true });
    await sync();
    await sync({ nowMs: NOW + DAY });
    const all = loggedText();
    expect(all).toContain('calendar_error'); // los espias capturan los logs
    for (const secret of ['privado', 'Medico', ACCESS, 'tok:', 'SECRET']) {
      expect(all).not.toContain(secret);
    }
  });

  describe('POST /api/sync', () => {
    it('401 sin token y sin llamar a Google', async () => {
      const res = await call('/api/sync', { method: 'POST', auth: null });
      expect(res.status).toBe(401);
      expect(requests).toHaveLength(0);
    });

    it('sincroniza y devuelve contadores; segunda en < 1 min -> 429', async () => {
      await connect();
      await addCalendar('a@x');
      google.put('a@x', timed('e1', '2026-11-01T09:00:00Z'));
      const res = await call('/api/sync', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: 'ok', completed: 1, upserted: 1 });
      expect(JSON.stringify(body)).not.toContain('a@x');
      expect((await call('/api/sync', { method: 'POST' })).status).toBe(429);
      setClock(() => NOW + 61_000);
      expect((await call('/api/sync', { method: 'POST' })).status).toBe(200);
    });

    it('sin Google conectado -> 409 google_not_connected', async () => {
      await addCalendar('a@x');
      const res = await call('/api/sync', { method: 'POST' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'google_not_connected' } });
    });

    it('con otra sync en curso -> 409 sync_busy', async () => {
      await acquireLock(env.DB, SYNC_LOCK_KEY, SYNC_LOCK_TTL_MS, NOW);
      const res = await call('/api/sync', { method: 'POST' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'sync_busy' } });
    });
  });
});
