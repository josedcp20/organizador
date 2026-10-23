import { describe, it, expect } from 'vitest';
import type { CalendarInfo, EventInfo } from '@organizador/shared';
import { formatEventTime, toRow, toRows } from './today';
import { calendarsWithSyncError, duplicateColors, formatAgo, syncErrorMessage } from './calendars';

function ev(over: Partial<EventInfo> = {}): EventInfo {
  return {
    id: 'e1',
    calendarId: 'c1',
    color: '#1a73e8',
    status: 'confirmed',
    summary: 'Reunion',
    location: null,
    description: null,
    allDay: false,
    startAt: '2026-10-23T08:30:00.000Z',
    endAt: '2026-10-23T09:30:00.000Z',
    startDate: null,
    endDate: null,
    recurringEventId: null,
    htmlLink: null,
    origin: 'google',
    notes: '',
    remind: false,
    remindDaysBefore: 5,
    writable: true,
    frozen: false,
    pending: null,
    ...over,
  };
}

function cal(over: Partial<CalendarInfo> = {}): CalendarInfo {
  return {
    id: 'a',
    name: 'A',
    color: '#1a73e8',
    visible: true,
    accessRole: 'owner',
    writable: true,
    lastSyncedAt: null,
    lastSyncError: null,
    ...over,
  };
}

describe('today rows', () => {
  it('formatea la hora en Europe/Madrid', () => {
    expect(formatEventTime(ev())).toBe('10:30 - 11:30');
    expect(formatEventTime(ev({ endAt: null }))).toBe('10:30');
  });
  it('dia completo', () => {
    expect(formatEventTime(ev({ allDay: true, startAt: null, startDate: '2026-10-23' }))).toBe(
      'Todo el día',
    );
  });
  it('evento multi-dia segun el dia mostrado', () => {
    // 22 oct 20:00 -> 24 oct 10:00 (Madrid, CEST)
    const e = ev({ startAt: '2026-10-22T18:00:00.000Z', endAt: '2026-10-24T08:00:00.000Z' });
    expect(formatEventTime(e, '2026-10-22')).toBe('desde 20:00');
    expect(formatEventTime(e, '2026-10-23')).toBe('Todo el día');
    expect(formatEventTime(e, '2026-10-24')).toBe('hasta 10:00');
    expect(formatEventTime(e)).toBe('20:00 - 10:00');
  });
  it('cruza medianoche', () => {
    // 23:00 -> 01:30 del dia siguiente en Madrid
    const e = ev({ startAt: '2026-10-23T21:00:00.000Z', endAt: '2026-10-23T23:30:00.000Z' });
    expect(formatEventTime(e, '2026-10-23')).toBe('desde 23:00');
    expect(formatEventTime(e, '2026-10-24')).toBe('hasta 01:30');
  });
  it('dia normal y fin a medianoche exacta', () => {
    expect(formatEventTime(ev(), '2026-10-23')).toBe('10:30 - 11:30');
    const e = ev({ startAt: '2026-10-23T20:00:00.000Z', endAt: '2026-10-23T22:00:00.000Z' });
    expect(formatEventTime(e, '2026-10-23')).toBe('22:00 - 00:00');
  });
  it('cambio de hora 2026-10-25 (CEST -> CET)', () => {
    // 24 oct 23:00 CEST (21:00Z) -> 25 oct 03:00 CET (02:00Z)
    const e = ev({ startAt: '2026-10-24T21:00:00.000Z', endAt: '2026-10-25T02:00:00.000Z' });
    expect(formatEventTime(e, '2026-10-24')).toBe('desde 23:00');
    expect(formatEventTime(e, '2026-10-25')).toBe('hasta 03:00');
    // 25 oct 00:30 CEST (22:30Z) -> 25 oct 05:00 CET (04:00Z)
    const f = ev({ startAt: '2026-10-24T22:30:00.000Z', endAt: '2026-10-25T04:00:00.000Z' });
    expect(formatEventTime(f, '2026-10-25')).toBe('00:30 - 05:00');
    // 25 oct 20:00 CET (19:00Z) -> 26 oct 08:00 CET (07:00Z)
    const g = ev({ startAt: '2026-10-25T19:00:00.000Z', endAt: '2026-10-26T07:00:00.000Z' });
    expect(formatEventTime(g, '2026-10-25')).toBe('desde 20:00');
    expect(formatEventTime(g, '2026-10-26')).toBe('hasta 08:00');
  });
  it('mapea campos, origen y pendiente', () => {
    const r = toRow(
      ev({ origin: 'app', location: ' Sala 1 ', pending: { op: 'insert', error: 'boom' } }),
    );
    expect(r).toMatchObject({
      title: 'Reunion',
      location: 'Sala 1',
      fromApp: true,
      pending: true,
      pendingError: 'boom',
      color: '#1a73e8',
    });
    expect(toRow(ev({ summary: null })).title).toBe('(Sin título)');
    expect(toRow(ev()).pending).toBe(false);
    expect(toRows([ev(), ev({ id: 'e2' })])).toHaveLength(2);
  });
});

describe('formatAgo', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  it('casos', () => {
    expect(formatAgo(null, now)).toBe('nunca');
    expect(formatAgo('basura', now)).toBe('nunca');
    expect(formatAgo('2026-10-23T11:59:30Z', now)).toBe('hace un momento');
    expect(formatAgo('2026-10-23T11:55:00Z', now)).toBe('hace 5 min');
    expect(formatAgo('2026-10-23T09:00:00Z', now)).toBe('hace 3 h');
    expect(formatAgo('2026-10-22T09:00:00Z', now)).toBe('hace 1 día');
    expect(formatAgo('2026-10-20T09:00:00Z', now)).toBe('hace 3 días');
  });
});

describe('calendarios', () => {
  it('detecta colores duplicados solo entre habilitados', () => {
    const d = duplicateColors([
      cal({ id: 'a', name: 'A' }),
      cal({ id: 'b', name: 'B', color: '#1A73E8' }),
      cal({ id: 'c', name: 'C', visible: false }),
      cal({ id: 'd', name: 'D', color: '#d93025' }),
    ]);
    expect([...d.values()]).toEqual([['A', 'B']]);
  });
  it('errores de sync solo de habilitados', () => {
    const r = calendarsWithSyncError([
      cal({ lastSyncError: 'x' }),
      cal({ id: 'b', visible: false, lastSyncError: 'y' }),
      cal({ id: 'c' }),
    ]);
    expect(r.map((c) => c.id)).toEqual(['a']);
  });
  it('mensajes de sync', () => {
    expect(syncErrorMessage({ code: 'rate_limited' })).toMatch(/minuto/);
    expect(syncErrorMessage({ code: 'sync_busy' })).toMatch(/en curso/);
    expect(syncErrorMessage(new Error('x'))).toMatch(/No se pudo/);
  });
});
