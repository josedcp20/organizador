/* global process */
import { afterEach, describe, it, expect } from 'vitest';
import {
  formatDateInTz,
  getStartOfDayInTz,
  getEndOfDayInTz,
  addDaysInTz,
  addDaysToDateStr,
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
