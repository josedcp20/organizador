/// <reference types="vite/client" />
import type { NoteInfo, QuickNoteInfo } from '@organizador/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setClock } from '../src/clock';
import { cleanupExpiredNotes } from '../src/jobs/cleanup';
import { type CallOptions, call as rawCall } from './helpers';

const call = (path: string, opts: CallOptions = {}) =>
  rawCall(path, { ip: '203.0.113.30', ...opts });
const jsonOpts = (method: string, body: unknown): CallOptions => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const post = (path: string, body: unknown) => call(path, jsonOpts('POST', body));
const patch = (path: string, body: unknown) => call(path, jsonOpts('PATCH', body));

// 2026-07-15 12:00 Madrid (CEST) = 10:00Z
const T0 = Date.parse('2026-07-15T10:00:00Z');
let nowMs: number;

beforeEach(async () => {
  nowMs = T0;
  setClock(() => nowMs);
  await env.DB.prepare('DELETE FROM notes').run();
});
afterEach(() => setClock());

async function quick(body: Record<string, unknown>, status = 201): Promise<QuickNoteInfo> {
  const r = await post('/api/quick-notes', { body: 'q', ...body });
  expect(r.status).toBe(status);
  return (await r.json()) as QuickNoteInfo;
}
async function errorCode(r: Response): Promise<string> {
  return ((await r.json()) as { error: { code: string } }).error.code;
}
const row = (id: string) =>
  env.DB.prepare(
    'SELECT remind_at, remind_state, remind_attempts, expires_at FROM notes WHERE id = ?',
  )
    .bind(id)
    .first<{
      remind_at: string | null;
      remind_state: string | null;
      remind_attempts: number;
      expires_at: string | null;
    }>();

describe('alta con remind_at', () => {
  it('hora local Madrid (CEST y CET) y offset explicito', async () => {
    const a = await quick({ remind_at: '2026-07-15T18:30' });
    expect(a.remindAt).toBe('2026-07-15T16:30:00.000Z');
    expect(a.remindState).toBe('pending');
    const b = await quick({ remind_at: '2026-10-27T18:30' });
    expect(b.remindAt).toBe('2026-10-27T17:30:00.000Z');
    const c = await quick({ remind_at: '2026-10-27T18:30:00+05:00' });
    expect(c.remindAt).toBe('2026-10-27T13:30:00.000Z');
    const d = await quick({ remind_at: '2026-10-27T17:30:00Z' });
    expect(d.remindAt).toBe('2026-10-27T17:30:00.000Z');
  });

  it('GET lo devuelve; sin alarma la forma de la respuesta no cambia', async () => {
    const withA = await quick({ remind_at: '2026-07-15T18:30' });
    const plain = await quick({});
    expect(Object.keys(plain).sort()).toEqual(['body', 'createdAt', 'expiresAt', 'id']);
    const list = (
      (await (await call('/api/quick-notes')).json()) as { quickNotes: QuickNoteInfo[] }
    ).quickNotes;
    expect(list.find((q) => q.id === withA.id)).toMatchObject({
      remindAt: '2026-07-15T16:30:00.000Z',
      remindState: 'pending',
    });
    expect(list.find((q) => q.id === plain.id)?.remindAt).toBeUndefined();
  });

  it('POST /api/notes con kind quick tambien acepta remind_at', async () => {
    const r = await post('/api/notes', { body: 'q', kind: 'quick', remind_at: '2026-07-15T18:30' });
    expect(r.status).toBe(201);
    const n = (await r.json()) as NoteInfo;
    expect(n.remindAt).toBe('2026-07-15T16:30:00.000Z');
    expect(n.remindState).toBe('pending');
  });

  it('DST primavera 2026-03-29: hora inexistente 02:30 -> 03:30 CEST = 01:30Z', async () => {
    nowMs = Date.parse('2026-03-20T10:00:00Z');
    const n = await quick({ remind_at: '2026-03-29T02:30' });
    expect(n.remindAt).toBe('2026-03-29T01:30:00.000Z');
    expect((await quick({ remind_at: '2026-03-29T01:30' })).remindAt).toBe(
      '2026-03-29T00:30:00.000Z',
    );
  });

  it('DST otono 2026-10-25: 02:30 ambigua -> segunda ocurrencia (01:30Z); primera con offset', async () => {
    expect((await quick({ remind_at: '2026-10-25T02:30' })).remindAt).toBe(
      '2026-10-25T01:30:00.000Z',
    );
    expect((await quick({ remind_at: '2026-10-25T02:30+02:00' })).remindAt).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it.each([
    '2026-07-15T18:35', // no multiplo de 10
    '2026-07-15T18:31',
    '2026-07-15T18:30:30', // segundos
    '2026-07-15T18:30:00.500+02:00', // ms
    '2026-07-15T11:00', // pasado (> 60 s)
    '2027-07-16T12:00', // > 365 d
    'manana',
    '2026-02-30T10:00',
    '2026-07-15T25:00',
  ])('remind_at invalido %s -> 400 y no se crea nada', async (v) => {
    const r = await post('/api/quick-notes', { body: 'q', remind_at: v });
    expect(r.status).toBe(400);
    expect(await errorCode(r)).toBe('validation');
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it('tipos no string -> 400; limites: -60 s y +365 d aceptados', async () => {
    for (const v of [5, true, {}, []]) {
      expect((await post('/api/quick-notes', { body: 'q', remind_at: v })).status).toBe(400);
    }
    nowMs = Date.parse('2026-07-15T10:05:00Z'); // 10:00Z es 5 min pasado
    expect(
      (await post('/api/quick-notes', { body: 'q', remind_at: '2026-07-15T10:00:00Z' })).status,
    ).toBe(400);
    nowMs = Date.parse('2026-07-15T10:00:30Z'); // 30 s pasado: tolerado
    expect(
      (await post('/api/quick-notes', { body: 'q', remind_at: '2026-07-15T10:00:00Z' })).status,
    ).toBe(201);
    nowMs = Date.parse('2026-07-15T10:00:00Z');
    expect(
      (await post('/api/quick-notes', { body: 'q', remind_at: '2027-07-15T10:00:00Z' })).status,
    ).toBe(201);
  });

  it('alarma en nota normal -> 400 (alta y PATCH)', async () => {
    const r = await post('/api/notes', { body: 'n', remind_at: '2026-07-15T18:30' });
    expect(r.status).toBe(400);
    const n = (await (await post('/api/notes', { body: 'n' })).json()) as NoteInfo;
    expect((await patch(`/api/notes/${n.id}`, { remind_at: '2026-07-15T18:30' })).status).toBe(400);
    expect((await patch(`/api/notes/${n.id}`, { remind_at: null })).status).toBe(400);
    expect((await row(n.id))?.remind_at).toBeNull();
  });

  it('Atajo text/plain sigue igual (sin alarma)', async () => {
    const r = await call('/api/quick-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hola',
    });
    expect(r.status).toBe(201);
    expect(await r.text()).toBe('Guardada (caduca el 16/07 a las 00:00)');
  });
});

describe('PATCH remind_at', () => {
  it('cambiar la alarma tras sent vuelve a pending con attempts 0', async () => {
    const n = await quick({ remind_at: '2026-07-15T18:30' });
    await env.DB.prepare("UPDATE notes SET remind_state = 'sent', remind_attempts = 4 WHERE id = ?")
      .bind(n.id)
      .run();
    const r = await patch(`/api/notes/${n.id}`, { remind_at: '2026-07-16T09:00' });
    expect(r.status).toBe(200);
    const out = (await r.json()) as NoteInfo;
    expect(out.remindAt).toBe('2026-07-16T07:00:00.000Z');
    expect(out.remindState).toBe('pending');
    expect(await row(n.id)).toMatchObject({ remind_state: 'pending', remind_attempts: 0 });
  });

  it('null limpia las tres columnas; editar solo el texto no toca la alarma', async () => {
    const n = await quick({ remind_at: '2026-07-15T18:30' });
    await env.DB.prepare(
      "UPDATE notes SET remind_state = 'gave_up', remind_attempts = 3 WHERE id = ?",
    )
      .bind(n.id)
      .run();
    const t = await patch(`/api/notes/${n.id}`, { body: 'nuevo' });
    expect(t.status).toBe(200);
    expect(await row(n.id)).toMatchObject({
      remind_at: '2026-07-15T16:30:00.000Z',
      remind_state: 'gave_up',
      remind_attempts: 3,
    });
    const r = await patch(`/api/notes/${n.id}`, { remind_at: null });
    expect(r.status).toBe(200);
    expect(await row(n.id)).toMatchObject({
      remind_at: null,
      remind_state: null,
      remind_attempts: 0,
    });
    const out = (await r.json()) as NoteInfo;
    expect(out.remindAt).toBeUndefined();
  });

  it('invalido -> 400 sin tocar nada; nota inexistente -> 404', async () => {
    const n = await quick({ remind_at: '2026-07-15T18:30' });
    expect((await patch(`/api/notes/${n.id}`, { remind_at: '2026-07-15T18:35' })).status).toBe(400);
    expect((await row(n.id))?.remind_at).toBe('2026-07-15T16:30:00.000Z');
    expect((await patch('/api/notes/nope', { remind_at: '2026-07-15T18:30' })).status).toBe(404);
  });
});

describe('caducidad con alarma', () => {
  it('"solo hoy" con alarma manana 09:00 -> expires_at = alarma + 24 h', async () => {
    const n = await quick({ remind_at: '2026-07-16T09:00' });
    expect(n.expiresAt).toBe('2026-07-17T07:00:00.000Z');
    expect((await row(n.id))?.expires_at).toBe('2026-07-17T07:00:00.000Z');
  });

  it('caducidad ya posterior no se acorta; sin caducidad sigue sin caducidad', async () => {
    const far = await quick({ remind_at: '2026-07-16T09:00', expiry: { type: 'days', days: 30 } });
    expect(far.expiresAt).toBe('2026-08-13T22:00:00.000Z');
    const forever = await quick({ remind_at: '2026-07-16T09:00', expiry: { type: 'forever' } });
    expect(forever.expiresAt).toBeNull();
  });

  it('cleanupExpiredNotes no borra una nota "solo hoy" con alarma pendiente', async () => {
    const n = await quick({ remind_at: '2026-07-16T09:00' });
    expect(await cleanupExpiredNotes(env.DB, Date.parse('2026-07-16T06:00:00Z'))).toBe(0);
    expect(await cleanupExpiredNotes(env.DB, Date.parse('2026-07-17T07:00:00Z'))).toBe(1);
    expect(await row(n.id)).toBeNull();
  });

  it('PATCH alarma extiende la caducidad; cambiar a "hoy" reaplica el clamp', async () => {
    const n = await quick({});
    expect(n.expiresAt).toBe('2026-07-15T22:00:00.000Z');
    const a = (await (
      await patch(`/api/notes/${n.id}`, { remind_at: '2026-07-16T09:00' })
    ).json()) as NoteInfo;
    expect(a.expiresAt).toBe('2026-07-17T07:00:00.000Z');
    // forever -> today con alarma pendiente: vuelve al clamp, no a las 00:00
    await patch(`/api/notes/${n.id}`, { expiry: { type: 'forever' } });
    const t = await patch(`/api/notes/${n.id}`, { expiry: { type: 'today' } });
    expect(((await t.json()) as NoteInfo).expiresAt).toBe('2026-07-17T07:00:00.000Z');
  });

  it('quitar la alarma no restaura la caducidad previa pero no la acorta', async () => {
    const n = await quick({ remind_at: '2026-07-16T09:00' });
    const r = await patch(`/api/notes/${n.id}`, { remind_at: null });
    expect(((await r.json()) as NoteInfo).expiresAt).toBe('2026-07-17T07:00:00.000Z');
  });

  it('alarma sent/gave_up ya no extiende la caducidad en ediciones posteriores', async () => {
    const n = await quick({ remind_at: '2026-07-16T09:00' });
    await env.DB.prepare("UPDATE notes SET remind_state = 'sent' WHERE id = ?").bind(n.id).run();
    const r = await patch(`/api/notes/${n.id}`, { expiry: { type: 'today' } });
    expect(((await r.json()) as NoteInfo).expiresAt).toBe('2026-07-15T22:00:00.000Z');
  });

  it('nota caducada no se resucita con PATCH -> 404', async () => {
    const n = await quick({});
    nowMs = Date.parse('2026-07-15T22:00:00Z');
    expect((await patch(`/api/notes/${n.id}`, { remind_at: '2026-07-16T09:00' })).status).toBe(404);
    expect(((await row(n.id)) as { expires_at: string }).expires_at).toBe(
      '2026-07-15T22:00:00.000Z',
    );
  });
});
