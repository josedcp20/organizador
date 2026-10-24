import type { EventInfo } from '@organizador/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { resolveMeta } from '../src/db/eventMeta';
import { call } from './helpers';

const ip = '203.0.113.31';
const CAL = 'a@x';

async function addCal(id: string, enabled = 1) {
  await env.DB.prepare(
    `INSERT INTO calendars (id, summary, google_color, color, enabled) VALUES (?1, ?1, '#9fe1e7', '#1a73e8', ?2)`,
  )
    .bind(id, enabled)
    .run();
}

async function addEvent(id: string, recurring: string | null = null, cal = CAL) {
  await env.DB.prepare(
    `INSERT INTO events (calendar_id, id, status, summary, all_day, start_at, end_at, recurring_event_id, origin)
     VALUES (?1, ?2, 'confirmed', ?2, 0, '2026-10-30T10:00:00.000Z', '2026-10-30T11:00:00.000Z', ?3, 'google')`,
  )
    .bind(cal, id, recurring)
    .run();
}

const path = (id: string, cal = CAL) =>
  `/api/agenda/${encodeURIComponent(cal)}/${encodeURIComponent(id)}/meta`;

const put = (id: string, body: unknown, opts: { cal?: string; auth?: string | null } = {}) =>
  call(path(id, opts.cal), {
    method: 'PUT',
    ip,
    auth: opts.auth,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const del = (id: string, scope?: string, opts: { cal?: string; auth?: string | null } = {}) =>
  call(`${path(id, opts.cal)}${scope === undefined ? '' : `?scope=${scope}`}`, {
    method: 'DELETE',
    ip,
    auth: opts.auth,
  });

async function ok(res: Response): Promise<EventInfo> {
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return (await res.json()) as EventInfo;
}

async function rows() {
  const { results } = await env.DB.prepare(
    `SELECT scope, target_id, notes, remind, remind_days_before, color FROM event_meta
     ORDER BY scope, target_id`,
  ).all();
  return results;
}

const DEFAULTS = { notes: '', remind: false, remindDaysBefore: 5, color: '#1a73e8' };

beforeEach(async () => {
  for (const t of ['event_meta', 'events', 'calendars']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  setClock(() => Date.parse('2026-10-23T10:00:00Z'));
  await addCal(CAL);
  await addEvent('plain');
  await addEvent('i1', 'ser');
  await addEvent('i2', 'ser');
});

afterEach(() => {
  setClock();
  vi.unstubAllGlobals();
});

describe('resolveMeta (pura)', () => {
  const v = (o: Partial<Record<string, unknown>> = {}) => ({
    notes: null,
    remind: null,
    remindDaysBefore: null,
    color: null,
    ...o,
  });

  it('defecto sin filas', () => {
    expect(resolveMeta(null, null)).toEqual({
      notes: '',
      remind: false,
      remindDaysBefore: 5,
      color: null,
    });
  });

  it('campo a campo instancia > serie > defecto; false/"" de instancia ganan a la serie', () => {
    expect(
      resolveMeta(
        v({ remind: false, notes: '' }),
        v({ notes: 'S', remind: true, remindDaysBefore: 9, color: '#00ff00' }),
      ),
    ).toEqual({ notes: '', remind: false, remindDaysBefore: 9, color: '#00ff00' });
  });
});

describe('PUT /api/agenda/:c/:e/meta', () => {
  it('upsert de instancia en evento no recurrente y relectura en GET/lista', async () => {
    const ev = await ok(
      await put('plain', {
        scope: 'instance',
        notes: 'Llevar DNI',
        remind: true,
        remind_days_before: 2,
        color: '#ABCDEF',
      }),
    );
    expect(ev).toMatchObject({
      id: 'plain',
      notes: 'Llevar DNI',
      remind: true,
      remindDaysBefore: 2,
      color: '#abcdef',
      metaScopes: {
        instance: { notes: 'Llevar DNI', remind: true, remindDaysBefore: 2, color: '#abcdef' },
        series: null,
      },
    });
    expect(await rows()).toEqual([
      {
        scope: 'instance',
        target_id: 'plain',
        notes: 'Llevar DNI',
        remind: 1,
        remind_days_before: 2,
        color: '#abcdef',
      },
    ]);
    const get = (await (await call('/api/agenda/a%40x/plain', { ip })).json()) as EventInfo;
    expect(get).toEqual(ev);
  });

  it('upsert parcial: un campo ausente no cambia, null vuelve a heredar', async () => {
    await ok(await put('plain', { scope: 'instance', notes: 'A', remind: true }));
    let ev = await ok(await put('plain', { scope: 'instance', remind_days_before: 7 }));
    expect(ev).toMatchObject({ notes: 'A', remind: true, remindDaysBefore: 7 });
    ev = await ok(await put('plain', { scope: 'instance', notes: null }));
    expect(ev).toMatchObject({ notes: '', remind: true, remindDaysBefore: 7 });
    expect(ev.metaScopes?.instance).toEqual({
      notes: null,
      remind: true,
      remindDaysBefore: 7,
      color: null,
    });
  });

  it('si todos los campos quedan a null se borra la fila', async () => {
    await ok(await put('plain', { scope: 'instance', notes: 'A' }));
    const ev = await ok(await put('plain', { scope: 'instance', notes: null }));
    expect(ev).toMatchObject(DEFAULTS);
    expect(ev.metaScopes).toEqual({ instance: null, series: null });
    expect(await rows()).toEqual([]);
  });

  it('scope series guarda por recurring_event_id y aplica a todas las instancias', async () => {
    const ev = await ok(
      await put('i1', { scope: 'series', notes: 'Serie', remind: true, color: '#00ff00' }),
    );
    expect(ev).toMatchObject({ notes: 'Serie', remind: true, remindDaysBefore: 5 });
    expect(await rows()).toEqual([
      {
        scope: 'series',
        target_id: 'ser',
        notes: 'Serie',
        remind: 1,
        remind_days_before: null,
        color: '#00ff00',
      },
    ]);
    const other = (await (await call('/api/agenda/a%40x/i2', { ip })).json()) as EventInfo;
    expect(other).toMatchObject({ notes: 'Serie', remind: true, color: '#00ff00' });
    expect(other.metaScopes).toEqual({
      instance: null,
      series: { notes: 'Serie', remind: true, remindDaysBefore: null, color: '#00ff00' },
    });
  });

  it('precedencia: solo instancia, ambos, campos parciales', async () => {
    // Solo instancia (en un evento recurrente): no afecta a las demas instancias.
    let ev = await ok(await put('i1', { scope: 'instance', notes: 'Inst', remind_days_before: 3 }));
    expect(ev).toMatchObject({ ...DEFAULTS, notes: 'Inst', remindDaysBefore: 3 });
    const i2 = (await (await call('/api/agenda/a%40x/i2', { ip })).json()) as EventInfo;
    expect(i2).toMatchObject(DEFAULTS);

    // Ambos: la serie rellena lo que la instancia no define.
    ev = await ok(
      await put('i2', {
        scope: 'series',
        notes: 'Serie',
        remind: true,
        remind_days_before: 10,
        color: '#00ff00',
      }),
    );
    expect(ev).toMatchObject({ notes: 'Serie', remind: true, remindDaysBefore: 10 });
    const i1 = (await (await call('/api/agenda/a%40x/i1', { ip })).json()) as EventInfo;
    expect(i1).toMatchObject({
      notes: 'Inst',
      remind: true,
      remindDaysBefore: 3,
      color: '#00ff00',
    });

    // remind=false explicito en la instancia gana al true de la serie.
    ev = await ok(await put('i1', { scope: 'instance', remind: false }));
    expect(ev).toMatchObject({ notes: 'Inst', remind: false, remindDaysBefore: 3 });
    // Guardar en la serie no borra el override de instancia.
    ev = await ok(await put('i1', { scope: 'series', notes: 'Serie 2' }));
    expect(ev).toMatchObject({ notes: 'Inst', remind: false });
  });

  it('series en evento no recurrente -> 400 sin escribir', async () => {
    const res = await put('plain', { scope: 'series', notes: 'x' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'validation' } });
    expect(await rows()).toEqual([]);
  });

  it('404 si el evento no existe, o su calendario no existe / esta oculto', async () => {
    await addCal('hidden@x', 0);
    await addEvent('h1', null, 'hidden@x');
    for (const [id, cal] of [
      ['nope', CAL],
      ['plain', 'nope@x'],
      ['h1', 'hidden@x'],
    ] as const) {
      const res = await put(id, { scope: 'instance', notes: 'x' }, { cal });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
      expect((await del(id, 'instance', { cal })).status).toBe(404);
    }
    expect(await rows()).toEqual([]);
  });

  it.each([
    ['sin scope', { notes: 'x' }],
    ['scope invalido', { scope: 'all', notes: 'x' }],
    ['sin campos', { scope: 'instance' }],
    ['clave desconocida', { scope: 'instance', notes: 'x', description: 'x' }],
    ['remind_days_before 0', { scope: 'instance', remind_days_before: 0 }],
    ['remind_days_before 61', { scope: 'instance', remind_days_before: 61 }],
    ['remind_days_before decimal', { scope: 'instance', remind_days_before: 2.5 }],
    ['remind_days_before string', { scope: 'instance', remind_days_before: '5' }],
    ['color sin #', { scope: 'instance', color: 'abcdef' }],
    ['color corto', { scope: 'instance', color: '#abc' }],
    ['color nombre', { scope: 'instance', color: 'red' }],
    ['remind no booleano', { scope: 'instance', remind: 1 }],
    ['notes no string', { scope: 'instance', notes: 5 }],
    ['notes > 10000', { scope: 'instance', notes: 'a'.repeat(10_001) }],
    ['array', [{ scope: 'instance' }]],
    ['null', null],
  ])('400 validation: %s', async (_name, body) => {
    const res = await put('i1', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'validation' } });
    expect(await rows()).toEqual([]);
  });

  it('400 con body que no es JSON', async () => {
    expect((await put('i1', '{nope')).status).toBe(400);
  });

  it('acepta los limites 1, 60 y notas de 10000', async () => {
    expect(
      (await ok(await put('plain', { scope: 'instance', remind_days_before: 1 }))).remindDaysBefore,
    ).toBe(1);
    expect(
      (await ok(await put('plain', { scope: 'instance', remind_days_before: 60 })))
        .remindDaysBefore,
    ).toBe(60);
    const notes = 'n'.repeat(10_000);
    expect((await ok(await put('plain', { scope: 'instance', notes }))).notes).toBe(notes);
  });
});

describe('DELETE /api/agenda/:c/:e/meta', () => {
  it('quitar personalizacion de la instancia vuelve a heredar de la serie', async () => {
    await ok(await put('i1', { scope: 'series', notes: 'Serie', remind: true }));
    await ok(await put('i1', { scope: 'instance', notes: 'Inst', remind: false }));
    const ev = await ok(await del('i1', 'instance'));
    expect(ev).toMatchObject({ notes: 'Serie', remind: true });
    expect(ev.metaScopes?.instance).toBeNull();
    expect(await rows()).toHaveLength(1);
  });

  it('borrar la serie conserva el override de instancia', async () => {
    await ok(await put('i1', { scope: 'series', notes: 'Serie', remind: true }));
    await ok(await put('i1', { scope: 'instance', notes: 'Inst' }));
    const ev = await ok(await del('i2', 'series'));
    expect(ev).toMatchObject(DEFAULTS);
    const i1 = (await (await call('/api/agenda/a%40x/i1', { ip })).json()) as EventInfo;
    expect(i1).toMatchObject({ notes: 'Inst', remind: false });
  });

  it('idempotente sin fila', async () => {
    expect(await ok(await del('plain', 'instance'))).toMatchObject(DEFAULTS);
  });

  it('400 con scope ausente/invalido o series en no recurrente', async () => {
    await ok(await put('plain', { scope: 'instance', notes: 'A' }));
    for (const s of [undefined, '', 'all']) {
      expect((await del('plain', s)).status).toBe(400);
    }
    expect((await del('plain', 'series')).status).toBe(400);
    expect(await rows()).toHaveLength(1);
  });
});

describe('auth y aislamiento de Google', () => {
  it('401 sin token en PUT y DELETE', async () => {
    expect((await put('plain', { scope: 'instance', notes: 'x' }, { auth: null })).status).toBe(
      401,
    );
    expect((await del('plain', 'instance', { auth: null })).status).toBe(401);
    expect(await rows()).toEqual([]);
  });

  it('no llama a fetch', async () => {
    const f = vi.fn(() => {
      throw new Error('fetch prohibido');
    });
    vi.stubGlobal('fetch', f);
    await ok(await put('i1', { scope: 'series', notes: 'x', color: '#000000' }));
    await ok(await put('i1', { scope: 'instance', remind: true }));
    await ok(await del('i1', 'instance'));
    await ok(await del('i1', 'series'));
    expect(f).not.toHaveBeenCalled();
  });
});
