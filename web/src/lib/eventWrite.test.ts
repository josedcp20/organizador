import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EventInfo } from '@organizador/shared';
import { ApiError } from './api';
import { setToken, clearToken } from './auth';
import {
  buildCreate,
  buildPatch,
  conflictCurrent,
  createEvent,
  defaultForm,
  deleteEvent,
  formFromEvent,
  updateEvent,
  validateForm,
  writeErrorMessage,
  type EventForm,
} from './eventWrite';

const ev = (o: Partial<EventInfo>): EventInfo => ({ id: 'e', summary: 'S', ...o }) as EventInfo;
const form = (o: Partial<EventForm> = {}): EventForm => ({
  summary: 'Reunion',
  location: '',
  description: '',
  allDay: false,
  startDate: '2026-11-02',
  startTime: '10:00',
  endDate: '2026-11-02',
  endTime: '11:00',
  ...o,
});
const allDay = (o: Partial<EventForm> = {}) =>
  form({ allDay: true, startTime: '', endTime: '', endDate: '2026-11-03', ...o });

describe('formFromEvent', () => {
  it('con hora (Madrid)', () => {
    const f = formFromEvent(
      ev({ startAt: '2026-11-02T09:00:00Z', endAt: '2026-11-02T10:30:00Z', allDay: false }),
    );
    expect(f).toMatchObject({ startDate: '2026-11-02', startTime: '10:00', endTime: '11:30' });
  });
  it('cruzando medianoche', () => {
    const f = formFromEvent(
      ev({ startAt: '2026-11-02T22:00:00Z', endAt: '2026-11-03T00:00:00Z', allDay: false }),
    );
    expect(f).toMatchObject({ startDate: '2026-11-02', startTime: '23:00', endDate: '2026-11-03' });
    expect(f.endTime).toBe('01:00');
  });
  it('dia completo de 1 dia: fin inclusivo = inicio', () => {
    const f = formFromEvent(ev({ allDay: true, startDate: '2026-11-02', endDate: '2026-11-03' }));
    expect(f).toMatchObject({ allDay: true, startDate: '2026-11-02', endDate: '2026-11-02' });
  });
  it('dia completo de varios dias', () => {
    const f = formFromEvent(ev({ allDay: true, startDate: '2026-11-02', endDate: '2026-11-05' }));
    expect(f.endDate).toBe('2026-11-04');
  });
});

describe('defaultForm', () => {
  it('a las 10:20 -> 11:00-12:00', () => {
    const f = defaultForm('2026-11-02', new Date('2026-11-02T09:20:00Z'));
    expect([f.startTime, f.endTime, f.startDate]).toEqual(['11:00', '12:00', '2026-11-02']);
  });
  it('a las 23:30 -> 23:00-23:59 mismo dia', () => {
    const f = defaultForm('2026-11-02', new Date('2026-11-02T22:30:00Z'));
    expect([f.startTime, f.endTime, f.endDate]).toEqual(['23:00', '23:59', '2026-11-02']);
  });
  it('a las 21:10 -> 22:00-23:00', () => {
    const f = defaultForm('2026-11-02', new Date('2026-11-02T20:10:00Z'));
    expect([f.startTime, f.endTime]).toEqual(['22:00', '23:00']);
  });
});

describe('validateForm', () => {
  it('valido', () => expect(validateForm(form())).toBeNull());
  it('titulo vacio', () => expect(validateForm(form({ summary: '  ' }))).toMatch(/título/));
  it('fin anterior al inicio', () => {
    expect(validateForm(form({ endTime: '09:00' }))).toMatch(/anterior/);
    expect(validateForm(form({ endTime: '10:00' }))).toBeNull();
  });
  it('fecha invalida', () => {
    expect(validateForm(form({ startDate: '2026-02-30' }))).toMatch(/fechas/);
    expect(validateForm(form({ startTime: '25:00' }))).toMatch(/horas/);
  });
  it('dia completo: fin >= inicio', () => {
    expect(validateForm(allDay({ endDate: '2026-11-01' }))).toMatch(/anterior/);
    expect(validateForm(allDay({ endDate: '2026-11-02' }))).toBeNull();
  });
  it('longitud', () => {
    expect(validateForm(form({ summary: 'x'.repeat(1025) }))).toMatch(/largo/);
  });
});

describe('buildCreate', () => {
  it('con hora: hora local, vacios a null', () => {
    expect(buildCreate(form({ location: ' ' }), 'cal', 'cid')).toEqual({
      client_id: 'cid',
      calendarId: 'cal',
      summary: 'Reunion',
      location: null,
      description: null,
      allDay: false,
      start: '2026-11-02T10:00',
      end: '2026-11-02T11:00',
    });
  });
  it('dia completo suma 1 dia al fin (cruza mes)', () => {
    const b = buildCreate(allDay({ startDate: '2026-11-30', endDate: '2026-11-30' }), 'c', 'i');
    expect([b.allDay, b.start, b.end]).toEqual([true, '2026-11-30', '2026-12-01']);
  });
  it('solo claves permitidas', () => {
    expect(Object.keys(buildCreate(form(), 'c', 'i')).sort()).toEqual([
      'allDay',
      'calendarId',
      'client_id',
      'description',
      'end',
      'location',
      'start',
      'summary',
    ]);
  });
});

describe('validateForm: anos', () => {
  it.each(['1969-12-31', '2101-01-01'])('rechaza %s', (d) => {
    expect(validateForm(form({ startDate: d, endDate: d }))).toMatch(/fechas no son válidas/);
  });
  it('acepta 2100-12-31', () => {
    expect(validateForm(form({ startDate: '2100-12-31', endDate: '2100-12-31' }))).toBeNull();
  });
});

describe('buildPatch', () => {
  it('sin cambios -> null', () => expect(buildPatch(form(), form())).toBeNull());
  it('solo titulo', () => {
    expect(buildPatch(form(), form({ summary: 'Otro' }))).toEqual({ summary: 'Otro' });
  });
  it('cambio de hora envia el trio', () => {
    expect(buildPatch(form(), form({ endTime: '12:00' }))).toEqual({
      allDay: false,
      start: '2026-11-02T10:00',
      end: '2026-11-02T12:00',
    });
  });
  it('hora ambigua (25-10-2026 02:30 primera vuelta): inicio sin cambios se envia con Z', () => {
    const i = form({
      startDate: '2026-10-25',
      startTime: '02:30',
      endDate: '2026-10-25',
      endTime: '03:30',
    });
    const orig = { startAt: '2026-10-25T00:30:00.000Z', endAt: '2026-10-25T02:30:00.000Z' };
    expect(buildPatch(i, { ...i, endTime: '04:00' }, orig)).toEqual({
      allDay: false,
      start: '2026-10-25T00:30:00.000Z',
      end: '2026-10-25T04:00',
    });
    expect(buildPatch(i, { ...i, startTime: '01:00' }, orig)).toEqual({
      allDay: false,
      start: '2026-10-25T01:00',
      end: '2026-10-25T02:30:00.000Z',
    });
  });
  it('dia completo: fin +1 dia', () => {
    expect(buildPatch(allDay(), allDay({ endDate: '2026-11-04' }))).toEqual({
      allDay: true,
      start: '2026-11-02',
      end: '2026-11-05',
    });
  });
  it('vaciar ubicacion y descripcion -> null', () => {
    const i = form({ location: 'Sala', description: 'x' });
    expect(buildPatch(i, form({ location: '', description: '' }))).toEqual({
      location: null,
      description: null,
    });
  });
  it('no cambia allDay aunque el form lo diga', () => {
    const p = buildPatch(form(), form({ allDay: true, endDate: '2026-11-03' }));
    expect(p?.allDay).toBe(false);
  });
});

const err = (status: number, code: string, body?: unknown) =>
  new ApiError(status, code, 'm', undefined, body);

describe('writeErrorMessage', () => {
  it.each([
    [403, 'calendar_forbidden', /permiso/, false],
    [423, 'frozen', /un mes/, false],
    [428, 'confirmation_required', /confirmar/, false],
    [409, 'write_pending', /enviándose/, true],
    [409, 'conflict', /cambiado/, false],
    [404, 'not_found', /ya no existe/, false],
    [410, 'gone', /ya no existe/, false],
    [502, 'google_error', /contactar/, true],
    [0, 'network', /contactar/, true],
    [400, 'validation', /Revisa/, false],
    [400, 'otro', /Revisa/, false],
  ] as [number, string, RegExp, boolean][])('%i %s', (status, code, re, retry) => {
    const r = writeErrorMessage(err(status, code));
    expect(r.text).toMatch(re);
    expect(r.retry).toBe(retry);
  });
  it('desconocido recurre a apiErrorMessage', () => {
    expect(writeErrorMessage(err(500, 'x')).text).toBe('Error del servidor (500).');
    expect(writeErrorMessage(new Error('x')).text).toBe('Error inesperado.');
  });
});

describe('conflictCurrent', () => {
  const cur = ev({ summary: 'G' });
  it('con current', () => {
    expect(conflictCurrent(err(409, 'conflict', { current: cur }))).toEqual(cur);
  });
  it('current null o ausente -> null', () => {
    expect(conflictCurrent(err(409, 'conflict', { current: null }))).toBeNull();
    expect(conflictCurrent(err(409, 'conflict'))).toBeNull();
  });
  it('otro error -> undefined', () => {
    expect(conflictCurrent(err(409, 'write_pending'))).toBeUndefined();
    expect(conflictCurrent(new Error('x'))).toBeUndefined();
  });
});

describe('llamadas a la API', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('VITE_API_BASE', 'https://w.example.workers.dev');
    setToken('t');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearToken();
  });
  const ok = () =>
    new Response('{"id":"e"}', { status: 201, headers: { 'Content-Type': 'application/json' } });

  it('createEvent hace POST /api/agenda con el body', async () => {
    fetchMock.mockResolvedValue(ok());
    const body = buildCreate(form(), 'c', 'cid');
    await createEvent(body);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://w.example.workers.dev/api/agenda');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(body);
  });
  it('updateEvent hace PATCH con ids codificados', async () => {
    fetchMock.mockResolvedValue(ok());
    await updateEvent('a@b', 'e1', { summary: 'x', confirm_external: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/agenda\/a%40b\/e1$/);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ summary: 'x', confirm_external: true });
  });
  it('deleteEvent manda confirm_external en la query y sin cuerpo', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteEvent('c', 'e', true);
    await deleteEvent('c', 'e', false);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/agenda\/c\/e\?confirm_external=true$/);
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/agenda\/c\/e$/);
  });
});
