/* global process */
import { afterEach, describe, it, expect } from 'vitest';
import {
  formatDateInTz,
  getStartOfDayInTz,
  getEndOfDayInTz,
  addDaysInTz,
  addDaysToDateStr,
  addMonthsToDateStr,
  startOfDateInTz,
  computeExpiresAt,
  isExpired,
  isValidExpiryDays,
} from './time';

const MAD = 'Europe/Madrid';
const iso = (d: Date) => d.toISOString();

describe('time utilities', () => {
  describe('formatDateInTz', () => {
    it('formatea una fecha simple en YYYY-MM-DD', () => {
      expect(formatDateInTz(new Date('2026-10-21T12:00:00Z'), MAD)).toBe('2026-10-21');
    });

    it('invierno y verano', () => {
      expect(formatDateInTz(new Date('2026-01-15T12:00:00Z'), MAD)).toBe('2026-01-15');
      expect(formatDateInTz(new Date('2026-07-15T12:00:00Z'), MAD)).toBe('2026-07-15');
    });

    it('cambia de fecha al cruzar la medianoche local', () => {
      expect(formatDateInTz(new Date('2026-10-21T21:59:59.999Z'), MAD)).toBe('2026-10-21');
      expect(formatDateInTz(new Date('2026-10-21T22:00:00.000Z'), MAD)).toBe('2026-10-22');
    });
  });

  describe('getStartOfDayInTz / getEndOfDayInTz', () => {
    it('dia normal con UTC+2', () => {
      const d = new Date('2026-10-21T12:00:00Z');
      expect(iso(getStartOfDayInTz(d, MAD))).toBe('2026-10-20T22:00:00.000Z');
      expect(iso(getEndOfDayInTz(d, MAD))).toBe('2026-10-21T21:59:59.999Z');
    });

    it('dia normal de invierno (UTC+1)', () => {
      const d = new Date('2026-01-15T12:00:00Z');
      expect(iso(getStartOfDayInTz(d, MAD))).toBe('2026-01-14T23:00:00.000Z');
      expect(iso(getEndOfDayInTz(d, MAD))).toBe('2026-01-15T22:59:59.999Z');
    });

    it('dia de 23h (2026-03-29)', () => {
      const d = new Date('2026-03-29T12:00:00Z');
      expect(iso(getStartOfDayInTz(d, MAD))).toBe('2026-03-28T23:00:00.000Z');
      expect(iso(getEndOfDayInTz(d, MAD))).toBe('2026-03-29T21:59:59.999Z');
    });

    it('dia de 25h (2026-10-25)', () => {
      const d = new Date('2026-10-25T12:00:00Z');
      expect(iso(getStartOfDayInTz(d, MAD))).toBe('2026-10-24T22:00:00.000Z');
      expect(iso(getEndOfDayInTz(d, MAD))).toBe('2026-10-25T22:59:59.999Z');
    });

    it('cruce de medianoche local', () => {
      const before = new Date('2026-10-21T21:59:59.999Z');
      const after = new Date('2026-10-21T22:00:00.000Z');
      expect(iso(getStartOfDayInTz(before, MAD))).toBe('2026-10-20T22:00:00.000Z');
      expect(iso(getStartOfDayInTz(after, MAD))).toBe('2026-10-21T22:00:00.000Z');
      expect(iso(getEndOfDayInTz(before, MAD))).toBe('2026-10-21T21:59:59.999Z');
      expect(iso(getEndOfDayInTz(after, MAD))).toBe('2026-10-22T21:59:59.999Z');
    });

    it('otras zonas: Asia/Tokyo y UTC', () => {
      const d = new Date('2026-10-21T12:00:00Z');
      expect(iso(getStartOfDayInTz(d, 'Asia/Tokyo'))).toBe('2026-10-20T15:00:00.000Z');
      expect(iso(getEndOfDayInTz(d, 'Asia/Tokyo'))).toBe('2026-10-21T14:59:59.999Z');
      expect(iso(getStartOfDayInTz(d, 'UTC'))).toBe('2026-10-21T00:00:00.000Z');
    });
  });

  describe('addDaysInTz (inicio del dia D+N)', () => {
    it('suma dias de calendario', () => {
      const d = new Date('2026-10-21T12:00:00Z');
      expect(iso(addDaysInTz(d, 0, MAD))).toBe('2026-10-20T22:00:00.000Z');
      expect(iso(addDaysInTz(d, 1, MAD))).toBe('2026-10-21T22:00:00.000Z');
      expect(iso(addDaysInTz(d, 5, MAD))).toBe('2026-10-25T23:00:00.000Z');
    });

    it('cruza el fin del horario de verano', () => {
      const d = new Date('2026-10-24T10:00:00Z');
      expect(iso(addDaysInTz(d, 1, MAD))).toBe('2026-10-24T22:00:00.000Z');
      expect(iso(addDaysInTz(d, 2, MAD))).toBe('2026-10-25T23:00:00.000Z');
    });

    it('cruza el inicio del horario de verano', () => {
      const d = new Date('2026-03-28T10:00:00Z');
      expect(iso(addDaysInTz(d, 2, MAD))).toBe('2026-03-29T22:00:00.000Z');
    });

    it('admite negativos y usa el dia local, no el UTC', () => {
      const d = new Date('2026-10-21T23:30:00Z'); // ya es 22 en Madrid
      expect(iso(addDaysInTz(d, -1, MAD))).toBe('2026-10-20T22:00:00.000Z');
    });
  });

  describe('addDaysToDateStr', () => {
    it('suma dias de calendario', () => {
      expect(addDaysToDateStr('2026-10-24', 2)).toBe('2026-10-26');
      expect(addDaysToDateStr('2026-12-31', 1)).toBe('2027-01-01');
      expect(addDaysToDateStr('2026-03-01', -1)).toBe('2026-02-28');
    });
  });

  describe('independencia de la TZ del proceso', () => {
    const original = process.env.TZ;
    const compute = () => {
      const a = new Date('2026-10-24T10:00:00Z');
      const b = new Date('2026-03-29T12:00:00Z');
      return [
        iso(getStartOfDayInTz(new Date('2026-10-21T12:00:00Z'), MAD)),
        iso(getEndOfDayInTz(b, MAD)),
        iso(getStartOfDayInTz(b, MAD)),
        iso(addDaysInTz(a, 2, MAD)),
        formatDateInTz(a, MAD),
      ];
    };
    const expected = [
      '2026-10-20T22:00:00.000Z',
      '2026-03-29T21:59:59.999Z',
      '2026-03-28T23:00:00.000Z',
      '2026-10-25T23:00:00.000Z',
      '2026-10-24',
    ];

    afterEach(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });

    for (const tz of ['UTC', 'Europe/Madrid', 'Asia/Tokyo']) {
      it(`resultados identicos con process.env.TZ=${tz}`, () => {
        process.env.TZ = tz;
        expect(compute()).toEqual(expected);
      });
    }
  });
});

describe('addMonthsToDateStr', () => {
  it('suma y resta meses cruzando anios', () => {
    expect(addMonthsToDateStr('2026-10-23', -1)).toBe('2026-09-23');
    expect(addMonthsToDateStr('2026-10-23', 12)).toBe('2027-10-23');
    expect(addMonthsToDateStr('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonthsToDateStr('2026-12-01', 1)).toBe('2027-01-01');
  });

  it('ajusta al ultimo dia del mes de destino', () => {
    expect(addMonthsToDateStr('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonthsToDateStr('2028-03-31', -1)).toBe('2028-02-29');
    expect(addMonthsToDateStr('2027-02-28', 12)).toBe('2028-02-28');
    expect(addMonthsToDateStr('2026-05-31', 12)).toBe('2027-05-31');
  });
});

describe('startOfDateInTz', () => {
  it('00:00 Madrid en invierno, verano y dias de cambio de hora', () => {
    expect(startOfDateInTz('2026-01-15', 'Europe/Madrid').toISOString()).toBe(
      '2026-01-14T23:00:00.000Z',
    );
    expect(startOfDateInTz('2026-07-15', 'Europe/Madrid').toISOString()).toBe(
      '2026-07-14T22:00:00.000Z',
    );
    expect(startOfDateInTz('2026-03-29', 'Europe/Madrid').toISOString()).toBe(
      '2026-03-28T23:00:00.000Z',
    );
    expect(startOfDateInTz('2026-10-25', 'Europe/Madrid').toISOString()).toBe(
      '2026-10-24T22:00:00.000Z',
    );
  });
});

describe('caducidad de notas (T3.1)', () => {
  const at = (s: string) => new Date(s);

  it('forever no caduca', () => {
    expect(computeExpiresAt({ type: 'forever' }, at('2026-10-21T10:00:00Z'))).toBeNull();
  });

  it('today a las 10:00 caduca a las 00:00 locales del dia siguiente (verano)', () => {
    expect(computeExpiresAt({ type: 'today' }, at('2026-07-15T08:00:00Z'))).toBe(
      '2026-07-15T22:00:00.000Z',
    );
  });

  it('today a las 23:50 locales caduca 10 minutos despues', () => {
    // 23:50 Madrid (CEST, UTC+2) = 21:50Z
    expect(computeExpiresAt({ type: 'today' }, at('2026-07-15T21:50:00Z'))).toBe(
      '2026-07-15T22:00:00.000Z',
    );
  });

  it('today justo a las 00:00 local caduca 24 h despues, no inmediatamente', () => {
    expect(computeExpiresAt({ type: 'today' }, at('2026-07-15T22:00:00Z'))).toBe(
      '2026-07-16T22:00:00.000Z',
    );
  });

  it('today a las 00:30 locales (aun dia UTC anterior) usa el dia local', () => {
    expect(computeExpiresAt({ type: 'today' }, at('2026-01-10T23:30:00Z'))).toBe(
      '2026-01-11T23:00:00.000Z',
    );
  });

  it('days 1 equivale a today; days 3 caduca a las 00:00 locales de creacion+3', () => {
    const n = at('2026-01-10T12:00:00Z');
    expect(computeExpiresAt({ type: 'days', days: 1 }, n)).toBe(
      computeExpiresAt({ type: 'today' }, n),
    );
    expect(computeExpiresAt({ type: 'days', days: 3 }, n)).toBe('2026-01-12T23:00:00.000Z');
  });

  it('cambio de hora de primavera 2026-03-29 (dia de 23 h)', () => {
    // today el 28 -> 00:00 del 29 (CET, +1) = 28T23:00Z
    expect(computeExpiresAt({ type: 'today' }, at('2026-03-28T12:00:00Z'))).toBe(
      '2026-03-28T23:00:00.000Z',
    );
    // today el 29 (dia de 23 h) -> 00:00 del 30 (CEST, +2) = 29T22:00Z
    expect(computeExpiresAt({ type: 'today' }, at('2026-03-29T10:00:00Z'))).toBe(
      '2026-03-29T22:00:00.000Z',
    );
    // days 2 desde el 28 cruza el cambio: 00:00 del 30 = 29T22:00Z (no 29T23:00Z)
    expect(computeExpiresAt({ type: 'days', days: 2 }, at('2026-03-28T12:00:00Z'))).toBe(
      '2026-03-29T22:00:00.000Z',
    );
    // days 7 desde el 25 (CET) -> 00:00 del 1-abr (CEST)
    expect(computeExpiresAt({ type: 'days', days: 7 }, at('2026-03-25T12:00:00Z'))).toBe(
      '2026-03-31T22:00:00.000Z',
    );
  });

  it('cambio de hora de otono 2026-10-25 (dia de 25 h)', () => {
    // today el 24 (CEST) -> 00:00 del 25 (aun CEST, +2) = 24T22:00Z
    expect(computeExpiresAt({ type: 'today' }, at('2026-10-24T12:00:00Z'))).toBe(
      '2026-10-24T22:00:00.000Z',
    );
    // today el 25 (dia de 25 h) -> 00:00 del 26 (CET, +1) = 25T23:00Z
    expect(computeExpiresAt({ type: 'today' }, at('2026-10-25T10:00:00Z'))).toBe(
      '2026-10-25T23:00:00.000Z',
    );
    // nota creada en la hora repetida (02:30 CET = 01:30Z) tambien caduca el 25T23:00Z
    expect(computeExpiresAt({ type: 'today' }, at('2026-10-25T01:30:00Z'))).toBe(
      '2026-10-25T23:00:00.000Z',
    );
    // days 2 desde el 24 -> 00:00 del 26 = 25T23:00Z
    expect(computeExpiresAt({ type: 'days', days: 2 }, at('2026-10-24T12:00:00Z'))).toBe(
      '2026-10-25T23:00:00.000Z',
    );
  });

  it('days 365 y cambio de anio', () => {
    expect(computeExpiresAt({ type: 'days', days: 365 }, at('2026-01-10T12:00:00Z'))).toBe(
      '2027-01-09T23:00:00.000Z',
    );
    expect(computeExpiresAt({ type: 'today' }, at('2026-12-31T20:00:00Z'))).toBe(
      '2026-12-31T23:00:00.000Z',
    );
  });

  it('respeta la zona indicada', () => {
    expect(computeExpiresAt({ type: 'today' }, at('2026-07-15T10:00:00Z'), 'Asia/Tokyo')).toBe(
      '2026-07-15T15:00:00.000Z',
    );
  });

  it('rechaza days fuera de 1..365 o no entero', () => {
    for (const days of [0, -1, 366, 1.5, NaN, Infinity]) {
      expect(() => computeExpiresAt({ type: 'days', days }, at('2026-01-10T12:00:00Z'))).toThrow(
        RangeError,
      );
    }
    expect(isValidExpiryDays(1)).toBe(true);
    expect(isValidExpiryDays(365)).toBe(true);
    expect(isValidExpiryDays('3')).toBe(false);
    expect(isValidExpiryDays(0)).toBe(false);
  });

  it('isExpired: frontera exacta, null y fechas invalidas', () => {
    const exp = '2026-07-15T22:00:00.000Z';
    const ms = Date.parse(exp);
    expect(isExpired(exp, ms - 1)).toBe(false);
    expect(isExpired(exp, ms)).toBe(true);
    expect(isExpired(exp, ms + 1)).toBe(true);
    expect(isExpired(null, ms)).toBe(false);
    expect(isExpired(undefined, ms)).toBe(false);
    expect(isExpired('basura', ms)).toBe(false);
  });

  it('es independiente de la TZ del proceso', () => {
    const prev = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        expect(computeExpiresAt({ type: 'today' }, at('2026-03-29T10:00:00Z'))).toBe(
          '2026-03-29T22:00:00.000Z',
        );
      }
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});
