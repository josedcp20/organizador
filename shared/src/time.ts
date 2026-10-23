/**
 * Helpers para trabajar con fechas/horas en la zona horaria Europe/Madrid
 */

const TZ = 'Europe/Madrid';

/**
 * Obtiene la fecha en formato YYYY-MM-DD para la zona horaria especificada
 * @param date Objeto Date (UTC)
 * @param tz Zona horaria (default: Europe/Madrid)
 * @returns Fecha en formato YYYY-MM-DD
 */
export function formatDateInTz(date: Date, tz: string = TZ): string {
  const formatter = new Intl.DateTimeFormat('es-ES', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: tz,
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

const DAY_MS = 86_400_000;

/** Milisegundos que `tz` va por delante de UTC en el instante `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  // Algunos motores devuelven "24" a medianoche
  const hour = get('hour') % 24;
  const wallAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  );
  // El formateador trunca a segundos
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Instante UTC (ms) de las 00:00 locales de `dateStr` (YYYY-MM-DD) en `tz`. */
function startOfLocalDateMs(dateStr: string, tz: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  // Desfases posibles alrededor de ese dia; el inicio es el primer instante cuyo reloj marca 00:00
  const candidates = new Set([
    wall - tzOffsetMs(wall - DAY_MS, tz),
    wall - tzOffsetMs(wall + DAY_MS, tz),
  ]);
  const valid = [...candidates].filter((t) => tzOffsetMs(t, tz) === wall - t).sort((a, b) => a - b);
  // Medianoche inexistente (salto de reloj): usar el desfase posterior al salto
  return valid[0] ?? wall - tzOffsetMs(wall + DAY_MS, tz);
}

/**
 * Suma `days` dias de calendario a una fecha YYYY-MM-DD (independiente de zona y de la TZ del proceso).
 */
export function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Obtiene el inicio del día local en UTC
 * @param date Objeto Date (UTC)
 * @param tz Zona horaria
 * @returns Instante UTC de las 00:00 locales del día de `date` en `tz`
 */
export function getStartOfDayInTz(date: Date, tz: string = TZ): Date {
  return new Date(startOfLocalDateMs(formatDateInTz(date, tz), tz));
}

/**
 * Obtiene el fin del día local en UTC
 * @param date Objeto Date (UTC)
 * @param tz Zona horaria
 * @returns Último milisegundo (23:59:59.999 local) del día de `date` en `tz`
 */
export function getEndOfDayInTz(date: Date, tz: string = TZ): Date {
  const nextDay = addDaysToDateStr(formatDateInTz(date, tz), 1);
  return new Date(startOfLocalDateMs(nextDay, tz) - 1);
}

/**
 * Suma `days` días de calendario (no 24h) al día local de `date` en `tz`.
 * Contrato: devuelve el INICIO del día (instante UTC, 00:00 local) del día D+N en `tz`.
 * Correcto cruzando cambios de horario. `days` puede ser negativo.
 * @param date Objeto Date (UTC)
 * @param days Número de días a sumar
 * @param tz Zona horaria
 */
export function addDaysInTz(date: Date, days: number, tz: string = TZ): Date {
  const target = addDaysToDateStr(formatDateInTz(date, tz), days);
  return new Date(startOfLocalDateMs(target, tz));
}

/**
 * Suma `months` meses de calendario a una fecha YYYY-MM-DD. Si el dia no existe en el mes de
 * destino se ajusta al ultimo dia (31-mar - 1 mes = 28/29-feb). `months` puede ser negativo.
 */
export function addMonthsToDateStr(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const targetMonth = m - 1 + months;
  const lastDay = new Date(Date.UTC(y, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, targetMonth, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** Instante UTC de las 00:00 locales de `dateStr` (YYYY-MM-DD) en `tz` (correcto en cambios de hora). */
export function startOfDateInTz(dateStr: string, tz: string = TZ): Date {
  return new Date(startOfLocalDateMs(dateStr, tz));
}
