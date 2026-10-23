import { addMonthsToDateStr, formatDateInTz, startOfDateInTz } from '@organizador/shared';

export const DEFAULT_TZ = 'Europe/Madrid';
export const WINDOW_MONTHS_BACK = 1;
export const WINDOW_MONTHS_AHEAD = 12;

/**
 * Ventana rodante de sync (D6): [hoy - 1 mes, hoy + 12 meses), calculada en Madrid.
 * - `startDate`/`endDate` (YYYY-MM-DD): para eventos de dia completo.
 * - `timeMin`/`timeMax` (ISO UTC, 00:00 Madrid de esas fechas): para eventos con hora y para la
 *   peticion de la pasada completa a Google.
 * Un evento cuyo inicio es anterior a `startDate`/`timeMin` esta CONGELADO: el sync no lo toca.
 */
export interface SyncWindow {
  today: string;
  startDate: string;
  endDate: string;
  timeMin: string;
  timeMax: string;
}

export function syncWindow(nowMs: number, tz: string = DEFAULT_TZ): SyncWindow {
  const today = formatDateInTz(new Date(nowMs), tz);
  const startDate = addMonthsToDateStr(today, -WINDOW_MONTHS_BACK);
  const endDate = addMonthsToDateStr(today, WINDOW_MONTHS_AHEAD);
  return {
    today,
    startDate,
    endDate,
    timeMin: startOfDateInTz(startDate, tz).toISOString(),
    timeMax: startOfDateInTz(endDate, tz).toISOString(),
  };
}

/** Dia local (Madrid) de un instante ISO; null si no es valido. */
export function localDay(iso: string | null, tz: string = DEFAULT_TZ): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? formatDateInTz(new Date(ms), tz) : null;
}
