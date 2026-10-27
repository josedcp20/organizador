import {
  addDaysToDateStr,
  formatDateInTz,
  type EventMetaScope,
  type EventsResponse,
  type TodayResponse,
} from '@organizador/shared';
import { Hono, type Context } from 'hono';
import { now } from '../clock';
import {
  deleteEventMeta,
  isMetaScope,
  parseMetaInput,
  upsertEventMeta,
  type MetaKey,
} from '../db/eventMeta';
import { setEventDone } from '../db/eventDone';
import { getEventById, listEventsInRange } from '../db/eventsRead';
import type { Env } from '../env';
import { errorBody } from '../errors';
import { DEFAULT_TZ } from '../sync/window';

/** Lectura de eventos y datos privados (event_meta) SOLO desde/en D1 (protegido por el middleware Bearer de /api/*). */
export const agenda = new Hono<{ Bindings: Env }>();

/** Rango maximo (dias, ambos extremos incluidos). */
export const MAX_RANGE_DAYS = 400;
const NO_STORE = 'no-store';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MIN_YEAR = 1970;
const MAX_YEAR = 2100;

/** Fecha real YYYY-MM-DD con ano en [1970, 2100] (fuera de ahi las conversiones lanzan RangeError). */
function isRealDate(s: string | undefined): s is string {
  if (!s || !DATE_RE.test(s)) return false;
  const year = Number(s.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  return addDaysToDateStr(s, 0) === s;
}

const tzOf = (env: Env) => env.TZ || DEFAULT_TZ;

const dayNumber = (s: string) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 86_400_000);

agenda.get('/api/agenda', async (c) => {
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (!isRealDate(from) || !isRealDate(to)) {
    return c.json(errorBody('validation', 'from and to must be valid dates (YYYY-MM-DD)'), 400);
  }
  if (to < from) {
    return c.json(errorBody('validation', 'to must not be before from'), 400);
  }
  if (dayNumber(to) - dayNumber(from) + 1 > MAX_RANGE_DAYS) {
    return c.json(errorBody('validation', `Range must not exceed ${MAX_RANGE_DAYS} days`), 400);
  }
  c.header('Cache-Control', NO_STORE);
  const body: EventsResponse = {
    from,
    to,
    events: await listEventsInRange(c.env.DB, from, to, { tz: tzOf(c.env) }),
  };
  return c.json(body);
});

agenda.get('/api/agenda/:calendarId/:eventId', async (c) => {
  const event = await getEventById(c.env.DB, c.req.param('calendarId'), c.req.param('eventId'), {
    tz: tzOf(c.env),
  });
  if (!event) return c.json(errorBody('not_found', 'Event not found'), 404);
  c.header('Cache-Control', NO_STORE);
  return c.json(event);
});

/**
 * Datos privados del evento (T3.6): notas, avisar, dias de antelacion, color. SOLO D1, nunca
 * Google. `scope='series'` usa recurring_event_id y solo vale para eventos recurrentes.
 */
agenda.put('/api/agenda/:calendarId/:eventId/meta', async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(errorBody('validation', 'Body must be JSON'), 400);
  }
  const input = parseMetaInput(raw);
  if (!input.ok) return c.json(errorBody('validation', input.message), 400);
  return withMetaTarget(c, input.scope, (key) => upsertEventMeta(c.env.DB, key, input.patch));
});

agenda.delete('/api/agenda/:calendarId/:eventId/meta', async (c) => {
  const scope = c.req.query('scope');
  if (!isMetaScope(scope)) {
    return c.json(errorBody('validation', "scope must be 'instance' or 'series'"), 400);
  }
  return withMetaTarget(c, scope, (key) => deleteEventMeta(c.env.DB, key));
});

/** Hecho (solo D1, nunca Google). Funciona en calendarios reader y eventos congelados. */
agenda.put('/api/agenda/:calendarId/:eventId/done', async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(errorBody('validation', 'Body must be JSON'), 400);
  }
  const o = raw as Record<string, unknown> | null;
  if (
    !o ||
    typeof o !== 'object' ||
    Array.isArray(o) ||
    Object.keys(o).length !== 1 ||
    typeof o.done !== 'boolean'
  ) {
    return c.json(errorBody('validation', 'Body must be { done: boolean }'), 400);
  }
  const calendarId = c.req.param('calendarId');
  const eventId = c.req.param('eventId');
  const opts = { tz: tzOf(c.env) };
  if (!(await getEventById(c.env.DB, calendarId, eventId, opts))) {
    return c.json(errorBody('not_found', 'Event not found'), 404);
  }
  await setEventDone(c.env.DB, calendarId, eventId, o.done);
  const updated = await getEventById(c.env.DB, calendarId, eventId, opts);
  if (!updated) return c.json(errorBody('not_found', 'Event not found'), 404);
  c.header('Cache-Control', NO_STORE);
  return c.json(updated);
});

/** Resuelve el evento (404), la clave del ambito (400 si `series` sin serie), aplica y relee. */
async function withMetaTarget(
  c: Context<{ Bindings: Env }>,
  scope: EventMetaScope,
  apply: (key: MetaKey) => Promise<unknown>,
) {
  const calendarId = c.req.param('calendarId')!;
  const eventId = c.req.param('eventId')!;
  const opts = { tz: tzOf(c.env) };
  const event = await getEventById(c.env.DB, calendarId, eventId, opts);
  if (!event) return c.json(errorBody('not_found', 'Event not found'), 404);
  let targetId = event.id;
  if (scope === 'series') {
    if (!event.recurringEventId) {
      return c.json(errorBody('validation', 'scope series requires a recurring event'), 400);
    }
    targetId = event.recurringEventId;
  }
  await apply({ calendarId, scope, targetId });
  const updated = await getEventById(c.env.DB, calendarId, eventId, opts);
  if (!updated) return c.json(errorBody('not_found', 'Event not found'), 404);
  c.header('Cache-Control', NO_STORE);
  return c.json(updated);
}

agenda.get('/api/today', async (c) => {
  const tz = tzOf(c.env);
  const nowMs = now();
  const today = formatDateInTz(new Date(nowMs), tz);
  const tomorrow = addDaysToDateStr(today, 1);
  const opts = { nowMs, tz };
  const [todayEvents, tomorrowEvents] = await Promise.all([
    listEventsInRange(c.env.DB, today, today, opts),
    listEventsInRange(c.env.DB, tomorrow, tomorrow, opts),
  ]);
  c.header('Cache-Control', NO_STORE);
  const body: TodayResponse = { today, tomorrow, todayEvents, tomorrowEvents };
  return c.json(body);
});
