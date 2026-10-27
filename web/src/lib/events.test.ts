import { describe, it, expect } from 'vitest';
import type { EventInfo } from '@organizador/shared';
import {
  mapEvent,
  eventTimeLabel,
  filterEvents,
  groupByDay,
  visibleRange,
  fetchRange,
  shiftAnchor,
  defaultView,
  startOfWeek,
} from './events';

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
    startAt: '2026-10-23T08:00:00.000Z', // 10:00 Madrid (CEST)
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

function allDay(over: Partial<EventInfo> = {}): EventInfo {
  return ev({
    allDay: true,
    startAt: null,
    endAt: null,
    startDate: '2026-10-23',
    endDate: '2026-10-24',
    ...over,
  });
}

describe('mapEvent', () => {
  it('evento con hora, origen google: horas en Madrid y color del servidor', () => {
    const m = mapEvent(ev())!;
    expect(m).toMatchObject({
      title: 'Reunion',
      color: '#1a73e8',
      allDay: false,
      startDay: '2026-10-23',
      endDay: '2026-10-23',
      startTime: '10:00',
      endTime: '11:30',
      multiDay: false,
      fromApp: false,
      pending: false,
    });
  });

  it('origen app marcado; sin titulo usa texto por defecto', () => {
    const m = mapEvent(ev({ origin: 'app', summary: null }))!;
    expect(m.fromApp).toBe(true);
    expect(m.title).toBe('(sin titulo)');
  });

  it('pending con y sin error', () => {
    const ok = mapEvent(ev({ pending: { op: 'insert', error: null } }))!;
    expect(ok.pending).toBe(true);
    expect(ok.pendingError).toBeNull();
    const bad = mapEvent(ev({ pending: { op: 'patch', error: 'calendar_forbidden' } }))!;
    expect(bad.pending).toBe(true);
    expect(bad.pendingError).toBe('calendar_forbidden');
  });

  it('dia completo de un dia: endDate exclusivo', () => {
    const m = mapEvent(allDay())!;
    expect(m).toMatchObject({ allDay: true, startDay: '2026-10-23', endDay: '2026-10-23' });
    expect(m.startTime).toBeNull();
    expect(m.multiDay).toBe(false);
  });

  it('dia completo multi-dia', () => {
    const m = mapEvent(allDay({ endDate: '2026-10-26' }))!;
    expect(m).toMatchObject({ startDay: '2026-10-23', endDay: '2026-10-25', multiDay: true });
  });

  it('con hora que cruza medianoche en Madrid es multi-dia', () => {
    const m = mapEvent(
      ev({ startAt: '2026-10-23T20:00:00.000Z', endAt: '2026-10-24T05:00:00.000Z' }),
    )!;
    expect(m).toMatchObject({ startDay: '2026-10-23', endDay: '2026-10-24', multiDay: true });
  });

  it('acabar a las 00:00 exactas no ocupa el dia siguiente; el dia es el de Madrid, no UTC', () => {
    // 22:00Z = 00:00 Madrid del 24 (CEST)
    const m = mapEvent(
      ev({ startAt: '2026-10-23T20:00:00.000Z', endAt: '2026-10-23T22:00:00.000Z' }),
    )!;
    expect(m.startDay).toBe('2026-10-23');
    expect(m.endDay).toBe('2026-10-23');
    const late = mapEvent(
      ev({ startAt: '2026-10-23T22:30:00.000Z', endAt: '2026-10-23T23:00:00.000Z' }),
    )!;
    expect(late.startDay).toBe('2026-10-24');
  });

  it('tentativo y datos invalidos', () => {
    expect(mapEvent(ev({ status: 'tentative' }))!.tentative).toBe(true);
    expect(mapEvent(ev({ startAt: null }))).toBeNull();
    expect(mapEvent(allDay({ startDate: null }))).toBeNull();
  });
});

describe('filtro y agrupacion', () => {
  const a = mapEvent(ev({ id: 'a', calendarId: 'c1' }))!;
  const b = mapEvent(ev({ id: 'b', calendarId: 'c2' }))!;
  const c = mapEvent(ev({ id: 'c', calendarId: 'c1', origin: 'app' }))!;

  it('oculta por calendario y por "creados en la app"', () => {
    const all = [a, b, c];
    expect(filterEvents(all, { hiddenCalendars: new Set(), showApp: true })).toHaveLength(3);
    expect(filterEvents(all, { hiddenCalendars: new Set(['c1']), showApp: true })).toEqual([b]);
    expect(filterEvents(all, { hiddenCalendars: new Set(), showApp: false })).toEqual([a, b]);
  });

  it('multi-dia aparece en cada dia, recortado al rango; dia completo primero', () => {
    const multi = mapEvent(allDay({ id: 'm', startDate: '2026-10-22', endDate: '2026-10-26' }))!;
    const timed = mapEvent(ev({ id: 't' }))!;
    const g = groupByDay([timed, multi], '2026-10-23', '2026-10-24');
    expect([...g.keys()]).toEqual(['2026-10-23', '2026-10-24']);
    expect(g.get('2026-10-23')!.map((e) => e.id)).toEqual(['m', 't']);
    expect(g.get('2026-10-24')!.map((e) => e.id)).toEqual(['m']);
  });
});

describe('rangos y navegacion', () => {
  it('semana empieza en lunes', () => {
    expect(startOfWeek('2026-10-23')).toBe('2026-10-19'); // viernes
    expect(visibleRange('week', '2026-10-25')).toEqual({ from: '2026-10-19', to: '2026-10-25' });
  });

  it('mes: 6 semanas desde el lunes de la semana del dia 1', () => {
    expect(visibleRange('month', '2026-10-23')).toEqual({ from: '2026-09-28', to: '2026-11-08' });
  });

  it('agenda: 30 dias desde el ancla; fetch con margen', () => {
    expect(visibleRange('agenda', '2026-10-23')).toEqual({ from: '2026-10-23', to: '2026-11-21' });
    expect(fetchRange('agenda', '2026-10-23', 7)).toEqual({ from: '2026-10-16', to: '2026-11-28' });
  });

  it('anterior/siguiente', () => {
    expect(shiftAnchor('month', '2026-03-31', 1)).toBe('2026-04-01');
    expect(shiftAnchor('month', '2026-01-15', -1)).toBe('2025-12-01');
    expect(shiftAnchor('week', '2026-10-23', 1)).toBe('2026-10-30');
    expect(shiftAnchor('agenda', '2026-10-23', -1)).toBe('2026-10-09');
  });

  it('vista por defecto segun ancho', () => {
    expect(defaultView(390)).toBe('agenda');
    expect(defaultView(699)).toBe('agenda');
    expect(defaultView(700)).toBe('month');
  });
});

describe('eventTimeLabel', () => {
  const base = mapEvent(ev())!;
  const multi = {
    ...base,
    allDay: false,
    multiDay: true,
    startDay: '2026-10-20',
    endDay: '2026-10-22',
    startTime: '22:00',
    endTime: '08:30',
  };
  it('un solo dia: rango u hora si compacto', () => {
    const one = { ...multi, multiDay: false, endDay: '2026-10-20' };
    expect(eventTimeLabel(one, '2026-10-20')).toBe('22:00 - 08:30');
    expect(eventTimeLabel(one, '2026-10-20', true)).toBe('22:00');
  });
  it('multi-dia ajusta por dia', () => {
    expect(eventTimeLabel(multi, '2026-10-20')).toBe('desde 22:00');
    expect(eventTimeLabel(multi, '2026-10-21')).toBe('Todo el día');
    expect(eventTimeLabel(multi, '2026-10-22')).toBe('hasta 08:30');
    expect(eventTimeLabel(multi, '2026-10-21', true)).toBe('');
  });
  it('dia completo -> vacio', () => {
    expect(eventTimeLabel({ ...multi, allDay: true, startTime: null }, '2026-10-21')).toBe('');
  });
});

describe('mapEvent: done', () => {
  it('done solo si es true', () => {
    expect(mapEvent(ev({ done: true }))!.done).toBe(true);
    expect(mapEvent(ev({ done: false }))!.done).toBe(false);
    expect(mapEvent(ev())!.done).toBe(false);
  });
});
