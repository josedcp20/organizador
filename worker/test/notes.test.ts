/// <reference types="vite/client" />
import type { NoteInfo, QuickNoteInfo } from '@organizador/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setClock } from '../src/clock';
import { DEFAULT_STEPS, runScheduled } from '../src/jobs/scheduled';
import { cleanupExpiredNotes } from '../src/jobs/cleanup';
import { type CallOptions, call as rawCall } from './helpers';

const call = (path: string, opts: CallOptions = {}) =>
  rawCall(path, { ip: '203.0.113.20', ...opts });
const jsonOpts = (method: string, body: unknown): CallOptions => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const post = (path: string, body: unknown) => call(path, jsonOpts('POST', body));
const patch = (path: string, body: unknown) => call(path, jsonOpts('PATCH', body));
const text = (path: string, body: string, extra: Record<string, string> = {}) =>
  call(path, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...extra }, body });

// 2026-07-15 12:00 Madrid (CEST) = 10:00Z
const T0 = Date.parse('2026-07-15T10:00:00Z');
let nowMs: number;

beforeEach(async () => {
  nowMs = T0;
  setClock(() => nowMs);
  await env.DB.prepare('DELETE FROM notes').run();
});
afterEach(() => setClock());

async function listNotes(query = ''): Promise<NoteInfo[]> {
  const r = await call(`/api/notes${query}`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { notes: NoteInfo[] }).notes;
}
async function listQuick(): Promise<QuickNoteInfo[]> {
  const r = await call('/api/quick-notes');
  expect(r.status).toBe(200);
  return ((await r.json()) as { quickNotes: QuickNoteInfo[] }).quickNotes;
}
async function errorCode(r: Response): Promise<string> {
  return ((await r.json()) as { error: { code: string } }).error.code;
}
async function create(body: unknown): Promise<NoteInfo> {
  const r = await post('/api/notes', body);
  expect(r.status).toBe(201);
  return (await r.json()) as NoteInfo;
}

describe('autenticacion', () => {
  const routes: [string, string][] = [
    ['GET', '/api/notes'],
    ['POST', '/api/notes'],
    ['PATCH', '/api/notes/x'],
    ['DELETE', '/api/notes/x'],
    ['GET', '/api/quick-notes'],
    ['POST', '/api/quick-notes'],
    ['DELETE', '/api/quick-notes/x'],
  ];
  it.each(routes)('%s %s sin token -> 401', async (method, path) => {
    const r = await rawCall(path, { method, auth: null, ip: '203.0.113.21' });
    expect(r.status).toBe(401);
    expect(await errorCode(r)).toBe('unauthorized');
  });
  it('token incorrecto -> 401 y no se crea nada', async () => {
    const r = await rawCall('/api/quick-notes', {
      method: 'POST',
      auth: 'Bearer ' + 'x'.repeat(43),
      ip: '203.0.113.22',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hola',
    });
    expect(r.status).toBe(401);
    expect(await listQuick()).toEqual([]);
  });
});

describe('POST /api/notes', () => {
  it('crea con valores por defecto (note, sin fijar, sin caducidad)', async () => {
    const n = await create({ body: '  hola  ' });
    expect(n).toMatchObject({
      kind: 'note',
      title: null,
      body: 'hola',
      pinned: false,
      expiresAt: null,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await listNotes()).toEqual([n]);
  });

  it('caducidad today / days / forever', async () => {
    const t = await create({ body: 'a', expiry: { type: 'today' } });
    expect(t.expiresAt).toBe('2026-07-15T22:00:00.000Z');
    const d = await create({ body: 'b', expiry: { type: 'days', days: 3 } });
    expect(d.expiresAt).toBe('2026-07-17T22:00:00.000Z');
    const f = await create({ body: 'c', expiry: { type: 'forever' } });
    expect(f.expiresAt).toBeNull();
  });

  it('acepta title, pinned y kind quick; titulo vacio -> null', async () => {
    const n = await create({ body: 'x', title: ' T ', pinned: true, kind: 'quick' });
    expect(n).toMatchObject({ title: 'T', pinned: true, kind: 'quick' });
    expect((await create({ body: 'y', title: '  ' })).title).toBeNull();
  });

  it('body de exactamente 10000 chars vale; 10001 no', async () => {
    expect((await post('/api/notes', { body: 'a'.repeat(10000) })).status).toBe(201);
    const r = await post('/api/notes', { body: 'a'.repeat(10001) });
    expect(r.status).toBe(400);
    expect(await errorCode(r)).toBe('validation');
  });

  const invalid: [string, unknown][] = [
    ['sin body', {}],
    ['body vacio', { body: '' }],
    ['body solo espacios', { body: '   \n ' }],
    ['body numero', { body: 5 }],
    ['campo desconocido', { body: 'x', color: 'red' }],
    ['id inyectado', { body: 'x', id: 'abc' }],
    ['title largo', { body: 'x', title: 'a'.repeat(201) }],
    ['title numero', { body: 'x', title: 3 }],
    ['kind invalido', { body: 'x', kind: 'otro' }],
    ['pinned string', { body: 'x', pinned: 'true' }],
    ['expiry string', { body: 'x', expiry: 'today' }],
    ['expiry tipo invalido', { body: 'x', expiry: { type: 'week' } }],
    ['days 0', { body: 'x', expiry: { type: 'days', days: 0 } }],
    ['days 366', { body: 'x', expiry: { type: 'days', days: 366 } }],
    ['days decimal', { body: 'x', expiry: { type: 'days', days: 1.5 } }],
    ['days string', { body: 'x', expiry: { type: 'days', days: '3' } }],
    ['days ausente', { body: 'x', expiry: { type: 'days' } }],
    ['days con today', { body: 'x', expiry: { type: 'today', days: 2 } }],
    ['expiry campo extra', { body: 'x', expiry: { type: 'today', foo: 1 } }],
    ['array', [{ body: 'x' }]],
    ['null', null],
  ];
  it.each(invalid)('rechaza %s con 400 validation', async (_n, body) => {
    const r = await post('/api/notes', body);
    expect(r.status).toBe(400);
    expect(await errorCode(r)).toBe('validation');
    expect(await listNotes()).toEqual([]);
  });

  it('JSON roto -> 400', async () => {
    const r = await call('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{no',
    });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/notes', () => {
  it('fijadas primero, luego mas recientes', async () => {
    const a = await create({ body: 'a' });
    nowMs += 1000;
    const b = await create({ body: 'b' });
    nowMs += 1000;
    const c = await create({ body: 'c', pinned: true });
    nowMs += 1000;
    const d = await create({ body: 'd' });
    expect((await listNotes()).map((n) => n.id)).toEqual([c.id, d.id, b.id, a.id]);
  });

  it('solo devuelve vigentes: caduca exactamente en expiresAt', async () => {
    const t = await create({ body: 'hoy', expiry: { type: 'today' } });
    const keep = await create({ body: 'siempre' });
    nowMs = Date.parse(t.expiresAt!) - 1;
    expect((await listNotes()).map((n) => n.id).sort()).toEqual([t.id, keep.id].sort());
    nowMs = Date.parse(t.expiresAt!);
    expect((await listNotes()).map((n) => n.id)).toEqual([keep.id]);
  });

  it('nota de las 23:50 solo hoy caduca a las 00:00 locales', async () => {
    nowMs = Date.parse('2026-07-15T21:50:00Z');
    const n = await create({ body: 'tarde', expiry: { type: 'today' } });
    expect(n.expiresAt).toBe('2026-07-15T22:00:00.000Z');
    nowMs = Date.parse('2026-07-15T21:59:59Z');
    expect(await listNotes()).toHaveLength(1);
    nowMs = Date.parse('2026-07-15T22:00:00Z');
    expect(await listNotes()).toHaveLength(0);
  });

  it('filtra por kind y valida el parametro', async () => {
    await create({ body: 'n' });
    await create({ body: 'q', kind: 'quick' });
    expect((await listNotes('?kind=note')).map((n) => n.body)).toEqual(['n']);
    expect((await listNotes('?kind=quick')).map((n) => n.body)).toEqual(['q']);
    expect(await listNotes()).toHaveLength(2);
    expect((await call('/api/notes?kind=zzz')).status).toBe(400);
  });

  it('no caduca nada con include_expired (parametro ignorado)', async () => {
    const t = await create({ body: 'x', expiry: { type: 'today' } });
    nowMs = Date.parse(t.expiresAt!) + 1;
    expect(await listNotes('?include_expired=1')).toEqual([]);
  });
});

describe('PATCH /api/notes/:id', () => {
  it('edita cuerpo, titulo, pinned y actualiza updatedAt', async () => {
    const n = await create({ body: 'a', title: 't' });
    nowMs += 5000;
    const r = await patch(`/api/notes/${n.id}`, { body: ' nuevo ', title: null, pinned: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      id: n.id,
      body: 'nuevo',
      title: null,
      pinned: true,
      createdAt: n.createdAt,
      updatedAt: new Date(nowMs).toISOString(),
    });
  });

  it('cambia la caducidad desde el instante de la edicion', async () => {
    const n = await create({ body: 'a', expiry: { type: 'today' } });
    nowMs = Date.parse('2026-07-15T20:00:00Z');
    let r = await patch(`/api/notes/${n.id}`, { expiry: { type: 'days', days: 2 } });
    expect(((await r.json()) as NoteInfo).expiresAt).toBe('2026-07-16T22:00:00.000Z');
    r = await patch(`/api/notes/${n.id}`, { expiry: { type: 'forever' } });
    expect(((await r.json()) as NoteInfo).expiresAt).toBeNull();
  });

  it('un PATCH sin expiry conserva la caducidad', async () => {
    const n = await create({ body: 'a', expiry: { type: 'days', days: 5 } });
    const r = await patch(`/api/notes/${n.id}`, { pinned: true });
    expect(((await r.json()) as NoteInfo).expiresAt).toBe(n.expiresAt);
  });

  it('404 si no existe o si ya caduco (no se resucita)', async () => {
    expect((await patch('/api/notes/no-existe', { body: 'x' })).status).toBe(404);
    const n = await create({ body: 'a', expiry: { type: 'today' } });
    nowMs = Date.parse(n.expiresAt!);
    const r = await patch(`/api/notes/${n.id}`, { expiry: { type: 'forever' } });
    expect(r.status).toBe(404);
    expect(await errorCode(r)).toBe('not_found');
    expect(await listNotes()).toEqual([]);
  });

  const invalid: [string, unknown][] = [
    ['vacio', {}],
    ['body vacio', { body: '' }],
    ['body largo', { body: 'a'.repeat(10001) }],
    ['desconocido', { kind: 'quick' }],
    ['id', { id: 'x' }],
    ['pinned no booleano', { pinned: 1 }],
    ['expiry invalido', { expiry: { type: 'days', days: 400 } }],
    ['array', []],
  ];
  it.each(invalid)('rechaza %s con 400', async (_n, body) => {
    const n = await create({ body: 'a' });
    const r = await patch(`/api/notes/${n.id}`, body);
    expect(r.status).toBe(400);
    expect(await errorCode(r)).toBe('validation');
    expect((await listNotes())[0].body).toBe('a');
  });

  it('tambien edita notas rapidas por esta ruta', async () => {
    const q = await create({ body: 'q', kind: 'quick' });
    const r = await patch(`/api/notes/${q.id}`, { body: 'q2' });
    expect(r.status).toBe(200);
    expect((await listQuick())[0].body).toBe('q2');
  });
});

describe('DELETE /api/notes/:id', () => {
  it('borra (204) y despues 404', async () => {
    const n = await create({ body: 'a' });
    expect((await call(`/api/notes/${n.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await listNotes()).toEqual([]);
    const r = await call(`/api/notes/${n.id}`, { method: 'DELETE' });
    expect(r.status).toBe(404);
    expect(await errorCode(r)).toBe('not_found');
  });
  it('una caducada responde 404 aunque siga en la tabla', async () => {
    const n = await create({ body: 'a', expiry: { type: 'today' } });
    nowMs = Date.parse(n.expiresAt!);
    expect((await call(`/api/notes/${n.id}`, { method: 'DELETE' })).status).toBe(404);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe('POST /api/quick-notes', () => {
  it('text/plain: el cuerpo es el texto; defecto caduca hoy; respuesta corta', async () => {
    const r = await text('/api/quick-notes', 'comprar pan\n');
    expect(r.status).toBe(201);
    expect(r.headers.get('Content-Type')).toContain('text/plain');
    // Verano (CEST): caduca a las 00:00 locales del dia siguiente (22:00Z), no 22:00.
    expect(await r.text()).toBe('Guardada (caduca el 16/07 a las 00:00)');
    const q = await listQuick();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ body: 'comprar pan', expiresAt: '2026-07-15T22:00:00.000Z' });
  });

  it('text/plain con charset y texto UTF-8', async () => {
    const r = await text('/api/quick-notes', 'cafe con leche - ñ 日本', {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    expect(r.status).toBe(201);
    expect((await listQuick())[0].body).toBe('cafe con leche - ñ 日本');
  });

  it.each([
    ['today', '2026-07-15T22:00:00.000Z'],
    ['1', '2026-07-15T22:00:00.000Z'],
    ['7', '2026-07-21T22:00:00.000Z'],
    ['365', '2027-07-14T22:00:00.000Z'],
    ['forever', null],
    ['FOREVER', null],
  ])('?days=%s', async (v, exp) => {
    const r = await text(`/api/quick-notes?days=${v}`, 'x');
    expect(r.status).toBe(201);
    expect((await listQuick())[0].expiresAt).toBe(exp);
  });

  it('?expiry= es alias de ?days= (plan)', async () => {
    await text('/api/quick-notes?expiry=forever', 'x');
    expect((await listQuick())[0].expiresAt).toBeNull();
  });

  it('forever: respuesta "sin caducidad"', async () => {
    const r = await text('/api/quick-notes?days=forever', 'x');
    expect(await r.text()).toBe('Guardada (sin caducidad)');
  });

  it.each(['0', '366', '-1', '1.5', 'abc', '', '1e2', '0x10', '3 dias', '0003x'])(
    '?days=%j invalido -> 400 y no crea',
    async (v) => {
      const r = await text(`/api/quick-notes?days=${encodeURIComponent(v)}`, 'x');
      expect(r.status).toBe(400);
      expect(await errorCode(r)).toBe('validation');
      expect(await listQuick()).toEqual([]);
    },
  );

  it('text/plain vacio, solo espacios o > 10000 -> 400', async () => {
    for (const b of ['', '   \n', 'a'.repeat(10001)]) {
      expect((await text('/api/quick-notes', b)).status).toBe(400);
    }
    expect((await text('/api/quick-notes', 'a'.repeat(10000))).status).toBe(201);
  });

  it('JSON: {body} y {body, expiry}; responde QuickNoteInfo', async () => {
    let r = await post('/api/quick-notes', { body: 'hola' });
    expect(r.status).toBe(201);
    const q = (await r.json()) as QuickNoteInfo;
    expect(q).toMatchObject({ body: 'hola', expiresAt: '2026-07-15T22:00:00.000Z' });
    expect(Object.keys(q).sort()).toEqual(['body', 'createdAt', 'expiresAt', 'id']);
    r = await post('/api/quick-notes', { body: 'h2', expiry: { type: 'days', days: 2 } });
    expect(((await r.json()) as QuickNoteInfo).expiresAt).toBe('2026-07-16T22:00:00.000Z');
  });

  it('JSON: query ?days= tambien vale; duplicado query+body -> 400', async () => {
    let r = await call('/api/quick-notes?days=forever', jsonOpts('POST', { body: 'x' }));
    expect(((await r.json()) as QuickNoteInfo).expiresAt).toBeNull();
    r = await call(
      '/api/quick-notes?days=2',
      jsonOpts('POST', { body: 'x', expiry: { type: 'today' } }),
    );
    expect(r.status).toBe(400);
  });

  it.each<[string, unknown]>([
    ['sin body', {}],
    ['body vacio', { body: '' }],
    ['body no string', { body: 1 }],
    ['campo desconocido', { body: 'x', pinned: true }],
    ['expiry invalido', { body: 'x', expiry: { type: 'days', days: 0 } }],
    ['array', []],
  ])('JSON invalido (%s) -> 400', async (_n, body) => {
    expect((await post('/api/quick-notes', body)).status).toBe(400);
    expect(await listQuick()).toEqual([]);
  });

  it('JSON roto -> 400', async () => {
    const r = await call('/api/quick-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(r.status).toBe(400);
  });

  it('invierno (CET): caduca a las 00:00 locales del dia siguiente', async () => {
    nowMs = Date.parse('2026-01-15T11:00:00Z');
    const r = await text('/api/quick-notes', 'x');
    expect(await r.text()).toBe('Guardada (caduca el 16/01 a las 00:00)');
    expect((await listQuick())[0].expiresAt).toBe('2026-01-15T23:00:00.000Z');
    const r2 = await text('/api/quick-notes?days=2', 'y');
    expect(await r2.text()).toBe('Guardada (caduca el 17/01 a las 00:00)');
  });

  it.each([
    ['application/x-www-form-urlencoded'],
    ['application/octet-stream'],
    ['Application/Octet-Stream; foo=bar'],
  ])('Content-Type %s se trata como texto plano', async (ct) => {
    const r = await call('/api/quick-notes', {
      method: 'POST',
      headers: { 'Content-Type': ct },
      body: 'a=1&b=2 cafe',
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('Content-Type')).toContain('text/plain');
    expect((await listQuick())[0].body).toBe('a=1&b=2 cafe');
  });

  it('sin Content-Type se trata como texto plano', async () => {
    const r = await call('/api/quick-notes', { method: 'POST', body: 'sin cabecera' });
    expect(r.status).toBe(201);
    expect((await listQuick())[0].body).toBe('sin cabecera');
  });

  it('sin Content-Type y sin cuerpo -> 400 (vacio)', async () => {
    expect((await call('/api/quick-notes', { method: 'POST' })).status).toBe(400);
  });

  it('Content-Type claramente distinto -> 415', async () => {
    for (const ct of ['multipart/form-data; boundary=x', 'image/png', 'text/html']) {
      const r = await call('/api/quick-notes', {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: 'x=1',
      });
      expect(r.status).toBe(415);
      expect(await errorCode(r)).toBe('unsupported_media_type');
    }
    expect(await listQuick()).toEqual([]);
  });

  it('cuerpo enorme -> 413 sin guardar', async () => {
    const r = await text('/api/quick-notes', 'a'.repeat(100_000));
    expect(r.status).toBe(413);
    expect(await listQuick()).toEqual([]);
  });
});

describe('GET/DELETE /api/quick-notes', () => {
  it('lista solo kind quick, vigentes, mas recientes primero', async () => {
    await create({ body: 'normal' });
    await text('/api/quick-notes', 'q1');
    nowMs += 1000;
    await text('/api/quick-notes', 'q2');
    expect((await listQuick()).map((q) => q.body)).toEqual(['q2', 'q1']);
    nowMs = Date.parse('2026-07-15T22:00:00Z');
    expect(await listQuick()).toEqual([]);
    expect(await listNotes()).toHaveLength(1);
  });

  it('DELETE borra la rapida; 404 para normal, inexistente o caducada', async () => {
    const q = await create({ body: 'q', kind: 'quick' });
    const normal = await create({ body: 'n' });
    expect((await call(`/api/quick-notes/${normal.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(await listNotes()).toHaveLength(2);
    expect((await call(`/api/quick-notes/${q.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/api/quick-notes/${q.id}`, { method: 'DELETE' })).status).toBe(404);
    const e = await create({ body: 'e', kind: 'quick', expiry: { type: 'today' } });
    nowMs = Date.parse(e.expiresAt!);
    expect((await call(`/api/quick-notes/${e.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('las notas nunca llaman a Google', () => {
  it('ninguna ruta de notas hace fetch saliente', async () => {
    const orig = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.reject(new Error('no network'));
    }) as typeof fetch;
    try {
      const n = await create({ body: 'secreto-nota' });
      await patch(`/api/notes/${n.id}`, { body: 'otro' });
      await listNotes();
      await text('/api/quick-notes', 'rapida');
      await listQuick();
      await call(`/api/notes/${n.id}`, { method: 'DELETE' });
      await runScheduled(
        env,
        nowMs,
        DEFAULT_STEPS.filter((s) => s.name === 'cleanup'),
      );
    } finally {
      globalThis.fetch = orig;
    }
    expect(urls).toEqual([]);
  });
});

describe('cleanup (T3.3)', () => {
  const count = async () =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first<{ n: number }>())!.n;

  it('borra notas y rapidas caducadas, conserva vigentes y sin caducidad', async () => {
    await create({ body: 'hoy', expiry: { type: 'today' } });
    await create({ body: 'q hoy', kind: 'quick', expiry: { type: 'today' } });
    await create({ body: 'tres dias', expiry: { type: 'days', days: 3 } });
    await create({ body: 'siempre' });
    await create({ body: 'q siempre', kind: 'quick', expiry: { type: 'forever' } });
    expect(await count()).toBe(5);

    // Antes de caducar: no borra nada
    expect(await cleanupExpiredNotes(env.DB, Date.parse('2026-07-15T21:59:59Z'))).toBe(0);
    expect(await count()).toBe(5);

    // Justo en la frontera caducan las de "hoy"
    expect(await cleanupExpiredNotes(env.DB, Date.parse('2026-07-15T22:00:00Z'))).toBe(2);
    expect(await count()).toBe(3);

    // Idempotente
    expect(await cleanupExpiredNotes(env.DB, Date.parse('2026-07-15T22:00:00Z'))).toBe(0);
    expect(await count()).toBe(3);

    // Mas tarde caduca la de 3 dias; las "siempre" permanecen
    expect(await cleanupExpiredNotes(env.DB, Date.parse('2026-07-18T22:00:00Z'))).toBe(1);
    expect(await cleanupExpiredNotes(env.DB, Date.parse('2030-01-01T00:00:00Z'))).toBe(0);
    expect((await env.DB.prepare('SELECT body FROM notes ORDER BY body').all()).results).toEqual([
      { body: 'q siempre' },
      { body: 'siempre' },
    ]);
  });

  it('tabla vacia: 0 y sin error', async () => {
    expect(await cleanupExpiredNotes(env.DB, nowMs)).toBe(0);
  });

  it('el despachador ejecuta cleanup con el reloj del cron y es idempotente', async () => {
    await create({ body: 'hoy', expiry: { type: 'today' } });
    await create({ body: 'siempre' });
    const cleanupOnly = DEFAULT_STEPS.filter((s) => s.name === 'cleanup');
    expect(cleanupOnly).toHaveLength(1);

    let r = await runScheduled(env, Date.parse('2026-07-15T21:00:00Z'), cleanupOnly);
    expect(r.failed).toEqual([]);
    expect(await count()).toBe(2);

    r = await runScheduled(env, Date.parse('2026-07-16T00:10:00Z'), cleanupOnly);
    expect(r.failed).toEqual([]);
    expect(await count()).toBe(1);

    r = await runScheduled(env, Date.parse('2026-07-16T00:20:00Z'), cleanupOnly);
    expect(r.failed).toEqual([]);
    expect(await count()).toBe(1);
  });

  it('el paso cleanup tambien purga auth_failures vencidas', async () => {
    await env.DB.prepare(
      'INSERT INTO auth_failures (ip, window_start, count, blocked_until) VALUES (?, ?, 3, NULL)',
    )
      .bind('old-key', '2020-01-01T00:00:00.000Z')
      .run();
    await runScheduled(
      env,
      nowMs,
      DEFAULT_STEPS.filter((s) => s.name === 'cleanup'),
    );
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM auth_failures WHERE ip = 'old-key'",
    ).first<{
      n: number;
    }>();
    expect(row?.n).toBe(0);
  });
});
