/// <reference types="vite/client" />
import { CALENDAR_PALETTE } from '@organizador/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { toBase64Url } from '../src/crypto/encoding';
import type { Env } from '../src/env';
import {
  eventsPath,
  googleRequest,
  isAllowedRequest,
  type GoogleMethod,
} from '../src/google/calendarApi';
import { importCalendars } from '../src/google/calendarList';
import {
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_URL,
  loadOAuthConfig,
  saveConnection,
} from '../src/google/oauth';
import { type CallOptions, call as rawCall } from './helpers';

const rand32 = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const OAUTH_ENV: Partial<Env> = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret-NOT-REAL',
  GOOGLE_REDIRECT_URI: 'https://organizador-api.jose-dcp20.workers.dev/oauth/google/callback',
  TOKEN_ENC_KEY: rand32(),
  OAUTH_STATE_KEY: rand32(),
};
const call = (path: string, opts: CallOptions = {}) =>
  rawCall(path, { ip: '203.0.113.9', env: OAUTH_ENV, ...opts });
const fullEnv = (): Env => ({ ...env, ...OAUTH_ENV }) as Env;

const ACCESS = 'ya29.access-SECRET';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Item = Record<string, unknown>;
let items: Item[];
let listPages: Item[][] | null;
let requests: { url: string; method: string; auth: string | null }[];
let tokenStatus: number;
let listFailure: Response | null;

const cal = (id: string, extra: Item = {}): Item => ({
  id,
  summary: `Cal ${id}`,
  accessRole: 'owner',
  selected: true,
  backgroundColor: '#9fe1e7',
  ...extra,
});

async function connect() {
  const cfg = (await loadOAuthConfig(fullEnv()))!;
  await saveConnection(
    env.DB,
    cfg,
    { access_token: ACCESS, expires_in: 3600, refresh_token: '1//refresh-SECRET' },
    [...GOOGLE_SCOPES],
  );
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM events').run();
  await env.DB.prepare('DELETE FROM calendars').run();
  await env.DB.prepare('DELETE FROM google_auth').run();
  setClock();
  items = [];
  listPages = null;
  requests = [];
  tokenStatus = 200;
  listFailure = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      requests.push({ url, method: init?.method ?? 'GET', auth: headers.get('Authorization') });
      if (url === GOOGLE_TOKEN_URL) {
        return tokenStatus === 200
          ? json({ access_token: ACCESS, expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') })
          : json({ error: 'invalid_grant' }, 400);
      }
      if (url.startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList')) {
        if (listFailure) return listFailure.clone();
        const pt = new URL(url).searchParams.get('pageToken');
        if (listPages) {
          const idx = pt ? Number(pt) : 0;
          const next = idx + 1 < listPages.length ? String(idx + 1) : undefined;
          return json({ items: listPages[idx], nextPageToken: next });
        }
        return json({ items });
      }
      throw new Error(`fetch inesperado a ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rows = async () =>
  (
    await env.DB.prepare('SELECT * FROM calendars ORDER BY sort_order').all<
      Record<string, unknown>
    >()
  ).results;

describe('importCalendars', () => {
  it('crea calendarios con color propio de la paleta, nombre, rol y visibilidad', async () => {
    await connect();
    items = [
      cal('a@x', { summary: 'Original', summaryOverride: 'Mi nombre' }),
      cal('b@x', { accessRole: 'reader', summary: 'Compartido' }),
      cal('c@x', { accessRole: 'freeBusyReader' }),
      cal('class', { accessRole: 'reader', selected: false }),
    ];
    const r = await importCalendars(fullEnv());
    expect(r).toEqual({ added: 4, updated: 0, removed: 0 });
    const all = await rows();
    expect(all.map((x) => x.summary)).toEqual(['Mi nombre', 'Compartido', 'Cal c@x', 'Cal class']);
    expect(all.map((x) => x.color)).toEqual(CALENDAR_PALETTE.slice(0, 4));
    expect(all.every((x) => x.google_color === '#9fe1e7')).toBe(true);
    expect(all.map((x) => x.enabled)).toEqual([1, 1, 1, 0]);
    // Solo GET a calendarList, con Bearer.
    const lists = requests.filter((q) => q.url.includes('calendarList'));
    expect(lists).toHaveLength(1);
    expect(lists[0]!.method).toBe('GET');
    expect(lists[0]!.auth).toBe(`Bearer ${ACCESS}`);
  });

  it('reimporte: actualiza nombre/rol/google_color pero preserva color y visibilidad del usuario', async () => {
    await connect();
    items = [cal('a@x'), cal('b@x', { selected: false })];
    await importCalendars(fullEnv());
    await env.DB.prepare("UPDATE calendars SET color='#123456', enabled=0 WHERE id='a@x'").run();
    await env.DB.prepare("UPDATE calendars SET enabled=1 WHERE id='b@x'").run();
    items = [
      cal('a@x', {
        summary: 'Nuevo',
        accessRole: 'reader',
        backgroundColor: '#000000',
        selected: true,
      }),
      cal('b@x', { selected: false }),
    ];
    const r = await importCalendars(fullEnv());
    expect(r).toEqual({ added: 0, updated: 2, removed: 0 });
    const [a, b] = await rows();
    expect(a).toMatchObject({
      summary: 'Nuevo',
      access_role: 'reader',
      google_color: '#000000',
      color: '#123456',
      enabled: 0,
    });
    expect(b).toMatchObject({ enabled: 1 });
  });

  it('nuevo calendario recibe el siguiente color libre (no el de Google)', async () => {
    await connect();
    items = [cal('a@x'), cal('b@x')];
    await importCalendars(fullEnv());
    await env.DB.prepare("UPDATE calendars SET color = ?1 WHERE id='a@x'")
      .bind(CALENDAR_PALETTE[0])
      .run();
    await env.DB.prepare("UPDATE calendars SET color = ?1 WHERE id='b@x'")
      .bind(CALENDAR_PALETTE[2])
      .run();
    items = [cal('a@x'), cal('b@x'), cal('c@x')];
    await importCalendars(fullEnv());
    const c = (await rows()).find((x) => x.id === 'c@x')!;
    // Usados: paleta[0] y paleta[2]; el primero libre es paleta[1].
    expect(c.color).toBe(CALENDAR_PALETTE[1]);
    expect(c.color).not.toBe('#9fe1e7');
  });

  it('con mas calendarios que colores rota la paleta', async () => {
    await connect();
    items = Array.from({ length: CALENDAR_PALETTE.length + 2 }, (_, i) => cal(`k${i}@x`));
    await importCalendars(fullEnv());
    const all = await rows();
    expect(all).toHaveLength(CALENDAR_PALETTE.length + 2);
    expect(all.every((x) => typeof x.color === 'string')).toBe(true);
  });

  it('marca como desaparecidos (sin borrar, con eventos) y los recupera si vuelven', async () => {
    await connect();
    items = [cal('a@x'), cal('b@x')];
    await importCalendars(fullEnv());
    await env.DB.prepare(
      "INSERT INTO events (calendar_id, id, status, all_day) VALUES ('b@x','e1','confirmed',0)",
    ).run();
    items = [cal('a@x')];
    const r = await importCalendars(fullEnv());
    expect(r.removed).toBe(1);
    const b = (await rows()).find((x) => x.id === 'b@x')!;
    expect(b.removed_at).toBeTruthy();
    const ev = await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>();
    expect(ev?.n).toBe(1);
    const res = await call('/api/calendars');
    const list = ((await res.json()) as { calendars: { id: string }[] }).calendars;
    expect(list.map((x) => x.id)).toEqual(['a@x']);
    // Un segundo import no lo vuelve a contar como removed.
    expect((await importCalendars(fullEnv())).removed).toBe(0);
    items = [cal('a@x'), cal('b@x')];
    await importCalendars(fullEnv());
    expect((await rows()).find((x) => x.id === 'b@x')!.removed_at).toBeNull();
  });

  it('dos imports concurrentes no fallan ni duplican filas', async () => {
    await connect();
    items = [cal('a@x'), cal('b@x')];
    const results = await Promise.all([importCalendars(fullEnv()), importCalendars(fullEnv())]);
    expect(results).toHaveLength(2);
    const all = await rows();
    expect(all.map((x) => x.id)).toEqual(['a@x', 'b@x']);
    expect(all.every((x) => typeof x.color === 'string')).toBe(true);
  });

  it('un calendario desaparecido sigue reservando su color', async () => {
    await connect();
    items = [cal('a@x'), cal('b@x')];
    await importCalendars(fullEnv());
    items = [cal('b@x'), cal('c@x')];
    await importCalendars(fullEnv());
    const all = await rows();
    const a = all.find((x) => x.id === 'a@x')!;
    const c = all.find((x) => x.id === 'c@x')!;
    expect(a.removed_at).toBeTruthy();
    expect(c.color).not.toBe(a.color);
  });

  it('regresion: un PATCH de color entre la lectura y el batch no hace repetir color al nuevo', async () => {
    // Bug T2.3: el color del calendario nuevo se calculaba con la foto leida al empezar; si el
    // usuario elegia ese color para otro calendario mientras tanto, el nuevo lo repetia.
    await connect();
    items = [cal('a@x')];
    await importCalendars(fullEnv());
    items = [cal('a@x'), cal('b@x')];
    const realDb = env.DB;
    const racingDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            // El usuario elige el siguiente color libre (rojo) para a@x justo antes del batch.
            await realDb
              .prepare("UPDATE calendars SET color = ?1 WHERE id = 'a@x'")
              .bind(CALENDAR_PALETTE[1])
              .run();
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await importCalendars({ ...fullEnv(), DB: racingDb });
    const all = await rows();
    expect(all.map((x) => x.color)).toEqual([CALENDAR_PALETTE[1], CALENDAR_PALETTE[0]]);
    expect(new Set(all.map((x) => x.color)).size).toBe(2);
  });

  it('imports concurrentes con distinto orden no repiten colores', async () => {
    await connect();
    const five = ['a@x', 'b@x', 'c@x', 'd@x', 'e@x'];
    items = five.map((id) => cal(id));
    const reversed = [...items].reverse();
    let n = 0;
    const order = () => (n++ % 2 === 0 ? items : reversed);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('calendarList')) return json({ items: order() });
      throw new Error('inesperado');
    });
    await Promise.all([importCalendars(fullEnv()), importCalendars(fullEnv())]);
    const colors = (await rows()).map((x) => x.color);
    expect(colors).toHaveLength(5);
    expect(new Set(colors).size).toBe(5);
  });

  it('colores en mayusculas guardados a mano cuentan como usados', async () => {
    await connect();
    items = [cal('a@x')];
    await importCalendars(fullEnv());
    await env.DB.prepare("UPDATE calendars SET color = '#1A73E8' WHERE id = 'a@x'").run();
    items = [cal('a@x'), cal('b@x')];
    await importCalendars(fullEnv());
    expect((await rows())[1]!.color).toBe(CALENDAR_PALETTE[1]);
  });

  it('sigue la paginacion', async () => {
    await connect();
    listPages = [[cal('p1@x')], [cal('p2@x')], [cal('p3@x')]];
    const r = await importCalendars(fullEnv());
    expect(r.added).toBe(3);
    expect(requests.filter((q) => q.url.includes('calendarList'))).toHaveLength(3);
  });
});

describe('rutas /api/calendars', () => {
  it('401 sin token en las tres rutas', async () => {
    for (const [path, method] of [
      ['/api/calendars', 'GET'],
      ['/api/calendars/refresh', 'POST'],
      ['/api/calendars/x', 'PATCH'],
    ] as const) {
      const res = await call(path, { method, auth: null });
      expect(res.status).toBe(401);
    }
  });

  it('refresh sin Google conectado -> google_not_connected y no llama a Google', async () => {
    const res = await call('/api/calendars/refresh', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'google_not_connected',
    );
    expect(requests).toHaveLength(0);
  });

  it('refresh con invalid_grant -> google_not_connected', async () => {
    await connect();
    await env.DB.prepare('UPDATE google_auth SET access_token = NULL').run();
    tokenStatus = 400;
    const res = await call('/api/calendars/refresh', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'google_not_connected',
    );
  });

  it.each([
    ['401', 401, { error: { errors: [{ reason: 'authError' }] } }],
    [
      '403 insufficientPermissions',
      403,
      { error: { errors: [{ reason: 'insufficientPermissions' }] } },
    ],
  ])(
    'refresh con %s de Google -> google_not_connected y olvida el access token',
    async (_n, status, body) => {
      await connect();
      listFailure = json(body, status);
      const res = await call('/api/calendars/refresh', { method: 'POST' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'google_not_connected',
      );
      const row = await env.DB.prepare('SELECT access_token FROM google_auth').first<{
        access_token: string | null;
      }>();
      expect(row?.access_token).toBeNull();
    },
  );

  it('refresh con 403 de otro tipo -> 502 google_unavailable', async () => {
    await connect();
    listFailure = json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 403);
    const res = await call('/api/calendars/refresh', { method: 'POST' });
    expect(res.status).toBe(502);
  });

  it('refresh importa y devuelve la lista; GET la devuelve con writable por rol', async () => {
    await connect();
    items = [
      cal('a@x'),
      cal('b@x', { accessRole: 'reader' }),
      cal('c@x', { accessRole: 'writer' }),
    ];
    const res = await call('/api/calendars/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    const list = ((await res.json()) as { calendars: Record<string, unknown>[] }).calendars;
    expect(list.map((x) => [x.id, x.writable, x.accessRole, x.visible])).toEqual([
      ['a@x', true, 'owner', true],
      ['b@x', false, 'reader', true],
      ['c@x', true, 'writer', true],
    ]);
    expect(Object.keys(list[0]!).sort()).toEqual(
      [
        'accessRole',
        'color',
        'id',
        'lastSyncError',
        'lastSyncedAt',
        'name',
        'visible',
        'writable',
      ].sort(),
    );
    const get = await call('/api/calendars');
    expect(((await get.json()) as { calendars: unknown[] }).calendars).toHaveLength(3);
  });

  describe('PATCH', () => {
    const patch = (id: string, body: unknown) =>
      call(`/api/calendars/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    beforeEach(async () => {
      await connect();
      items = [cal('a@x')];
      await importCalendars(fullEnv());
      requests = [];
    });

    it('cambia color y visible solo en D1 (sin llamadas a Google)', async () => {
      const res = await patch('a@x', { color: '#AABBCC', visible: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: 'a@x', color: '#aabbcc', visible: false });
      const [a] = await rows();
      expect(a).toMatchObject({ color: '#aabbcc', enabled: 0 });
      expect(requests).toHaveLength(0);
    });

    it('acepta solo visible o solo color', async () => {
      expect((await patch('a@x', { visible: false })).status).toBe(200);
      expect((await patch('a@x', { color: '#010203' })).status).toBe(200);
      const [a] = await rows();
      expect(a).toMatchObject({ color: '#010203', enabled: 0 });
    });

    it.each([
      ['#abc'],
      ['abcdef'],
      ['#abcdeg'],
      ['#aabbccdd'],
      ['red'],
      [' #aabbcc'],
      [123],
      [null],
    ])('rechaza color invalido %j', async (color) => {
      const res = await patch('a@x', { color });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation');
    });

    it('rechaza visible no booleano, campos extra, body vacio y no JSON', async () => {
      expect((await patch('a@x', { visible: 'yes' })).status).toBe(400);
      expect((await patch('a@x', { visible: 1 })).status).toBe(400);
      expect((await patch('a@x', { color: '#aabbcc', name: 'x' })).status).toBe(400);
      expect((await patch('a@x', { accessRole: 'owner' })).status).toBe(400);
      expect((await patch('a@x', {})).status).toBe(400);
      expect((await patch('a@x', [])).status).toBe(400);
      expect((await patch('a@x', 'nope{')).status).toBe(400);
      const [a] = await rows();
      expect(a).toMatchObject({ color: CALENDAR_PALETTE[0], enabled: 1 });
    });

    it('404 si no existe o esta desaparecido', async () => {
      const res = await patch('nope@x', { visible: true });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
      await env.DB.prepare("UPDATE calendars SET removed_at='2026-01-01T00:00:00Z'").run();
      expect((await patch('a@x', { visible: true })).status).toBe(404);
    });
  });
});

describe('googleRequest (allowlist)', () => {
  it('permite GET users/me/calendarList', async () => {
    items = [cal('a@x')];
    await expect(googleRequest('GET', 'users/me/calendarList', { token: 't' })).resolves.toEqual({
      items,
    });
  });

  it('permite GET calendars/{id}/events (events.list, solo lectura) con id codificado', async () => {
    expect(isAllowedRequest('GET', 'calendars/primary/events')).toBe(true);
    expect(
      isAllowedRequest('GET', eventsPath('es.spain#holiday@group.v.calendar.google.com')),
    ).toBe(true);
    expect(eventsPath('a/b@x')).toBe('calendars/a%2Fb%40x/events');
    expect(isAllowedRequest('GET', eventsPath('a/b@x'))).toBe(true);
  });

  it.each([
    ['POST', 'users/me/calendarList'],
    ['PATCH', 'users/me/calendarList'],
    ['DELETE', 'users/me/calendarList'],
    ['PUT', 'users/me/calendarList'],
    ['GET', 'users/me/calendarList/x'],
    ['GET', '../../oauth2/v1/userinfo'],
    // Escrituras fuera de la allowlist de T2.10 (insert/patch/delete de UN evento; ver
    // test/eventsWrite.test.ts para las permitidas).
    ['PATCH', 'calendars/primary/events'],
    ['PUT', 'calendars/primary/events'],
    ['PUT', 'calendars/primary/events/e1'],
    ['DELETE', 'calendars/primary/events'],
    ['POST', 'calendars/primary/events/e1'],
    ['POST', 'calendars/primary/events/quickAdd'],
    ['POST', 'calendars/primary/events/import'],
    ['POST', 'calendars/primary/events/e1/move'],
    ['POST', 'calendars/primary/events/watch'],
    ['PATCH', 'calendars/primary/events/quickAdd'],
    ['PATCH', 'calendars/primary/events/IMPORT'],
    ['DELETE', 'calendars/primary/events/watch'],
    ['PATCH', 'calendars/primary/events/e1/move'],
    ['DELETE', 'calendars/primary/events/..'],
    ['DELETE', 'calendars/primary/events/%2E'],
    ['PATCH', 'calendars/primary/events/e1?x=1'],
    ['DELETE', 'calendars/primary/events/'],
    ['POST', 'calendars/primary/acl'],
    ['DELETE', 'calendars/primary/acl/user:x'],
    ['POST', 'calendars'],
    ['POST', 'users/me/calendarList/x'],
    // Otras lecturas no previstas y rutas maliciosas.
    ['GET', 'calendars/primary/events/import'],
    ['GET', 'calendars/primary/events/e1/instances'],
    ['GET', 'calendars/primary'],
    ['GET', 'calendars/primary/acl'],
    ['GET', 'calendars/a/b/events'],
    ['GET', 'calendars//events'],
    ['GET', 'calendars/../events'],
    ['GET', 'calendars/./events'],
    ['GET', 'calendars/%2e%2e/events'],
    ['GET', 'calendars/x?y=1/events'],
    ['GET', 'calendars/x#/events'],
    ['GET', 'calendars/primary/events?alt=media'],
    ['GET', '/calendars/primary/events'],
    ['DELETE', 'calendars/primary'],
  ] as const)('rechaza %s %s sin hacer red', async (method, path) => {
    await expect(googleRequest(method as GoogleMethod, path, { token: 't' })).rejects.toThrow(
      /not_allowed/,
    );
    expect(requests).toHaveLength(0);
  });
});

describe('aislamiento de Calendar API', () => {
  it('solo calendarApi.ts contiene la URL base de calendar/v3', () => {
    const files = import.meta.glob('../src/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const needle = 'googleapis.com/' + 'calendar';
    const offenders = Object.entries(files)
      .filter(([, src]) => src.includes(needle))
      .map(([f]) => f);
    expect(Object.keys(files).length).toBeGreaterThan(5);
    expect(offenders).toEqual(['../src/google/calendarApi.ts']);
  });
});
