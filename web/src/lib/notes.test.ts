import { describe, it, expect } from 'vitest';
import {
  alarmLabel,
  defaultAlarmLocal,
  roundAlarmLocal,
  toMadridLocalInput,
  validateAlarm,
} from './notes';

describe('alarmas: helpers', () => {
  it('toMadridLocalInput usa hora de Madrid (verano e invierno)', () => {
    expect(toMadridLocalInput('2026-10-27T17:30:00.000Z')).toBe('2026-10-27T18:30');
    expect(toMadridLocalInput('2026-07-01T16:30:00.000Z')).toBe('2026-07-01T18:30');
    expect(toMadridLocalInput('nope')).toBe('');
  });

  it('roundAlarmLocal baja a multiplos de 10 y rechaza formatos raros', () => {
    expect(roundAlarmLocal('2026-10-27T18:37')).toBe('2026-10-27T18:30');
    expect(roundAlarmLocal('2026-10-27T18:50')).toBe('2026-10-27T18:50');
    expect(roundAlarmLocal('2026-10-27')).toBe('');
  });

  it('defaultAlarmLocal es la proxima hora en punto de Madrid', () => {
    expect(defaultAlarmLocal(Date.parse('2026-10-27T17:10:00Z'))).toBe('2026-10-27T19:00');
  });

  it('validateAlarm: minutos de 10 en 10 y no pasado', () => {
    const now = Date.parse('2026-10-27T17:10:00Z'); // 18:10 Madrid
    expect(validateAlarm('2026-10-27T18:30', now)).toBe('');
    expect(validateAlarm('2026-10-27T18:35', now)).toMatch(/de 10 en 10/);
    expect(validateAlarm('2026-10-27T18:00', now)).toMatch(/pasado/);
    expect(validateAlarm('', now)).toMatch(/fecha y hora/);
  });

  it('alarmLabel por estado, en Madrid aunque el dispositivo este en otra zona', () => {
    const remindAt = '2026-10-27T17:30:00.000Z';
    expect(alarmLabel({ remindAt, remindState: 'pending' })).toBe('Alarma: mar 27/10 18:30');
    expect(alarmLabel({ remindAt, remindState: 'sent' })).toBe('Sonó a las 18:30');
    expect(alarmLabel({ remindAt, remindState: 'gave_up' })).toBe('No se pudo avisar');
    expect(alarmLabel({ remindAt: null })).toBeNull();
    expect(alarmLabel({})).toBeNull();
  });
});
