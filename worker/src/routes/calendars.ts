import { isHexColor, type CalendarsResponse } from '@organizador/shared';
import { Hono } from 'hono';
import type { Env } from '../env';
import { errorBody } from '../errors';
import { getCalendar, listCalendars, updateCalendar } from '../db/calendars';
import { GoogleApiError, importCalendars } from '../google/calendarList';
import { GoogleAuthError } from '../google/oauth';

/**
 * Calendarios (protegido por el middleware Bearer de /api/*). Color y visibilidad se guardan
 * SOLO en D1: ninguna ruta de aqui escribe en Google (calendarList solo se lee en el refresh).
 */
export const calendars = new Hono<{ Bindings: Env }>();

const ALLOWED_FIELDS = new Set(['color', 'visible']);
const NO_STORE = 'no-store';

calendars.get('/api/calendars', async (c) => {
  c.header('Cache-Control', NO_STORE);
  const body: CalendarsResponse = { calendars: await listCalendars(c.env.DB) };
  return c.json(body);
});

calendars.post('/api/calendars/refresh', async (c) => {
  c.header('Cache-Control', NO_STORE);
  try {
    await importCalendars(c.env);
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      if (e.code === 'misconfigured') {
        return c.json(errorBody('misconfigured', 'Google OAuth is not configured'), 500);
      }
      if (e.code === 'unavailable') {
        return c.json(errorBody('google_unavailable', 'Google is not available'), 502);
      }
      return c.json(errorBody('google_not_connected', 'Google is not connected'), 409);
    }
    if (e instanceof GoogleApiError) {
      return c.json(errorBody('google_unavailable', 'Google request failed'), 502);
    }
    throw e;
  }
  const body: CalendarsResponse = { calendars: await listCalendars(c.env.DB) };
  return c.json(body);
});

calendars.patch('/api/calendars/:id', async (c) => {
  const id = c.req.param('id');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(errorBody('validation', 'Body must be JSON'), 400);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return c.json(errorBody('validation', 'Body must be an object'), 400);
  }
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((k) => !ALLOWED_FIELDS.has(k))) {
    return c.json(errorBody('validation', 'Only color and visible are allowed'), 400);
  }
  const patch: { color?: string; visible?: boolean } = {};
  if ('color' in body) {
    if (!isHexColor(body.color)) {
      return c.json(errorBody('validation', 'color must be #rrggbb'), 400);
    }
    patch.color = body.color.toLowerCase();
  }
  if ('visible' in body) {
    if (typeof body.visible !== 'boolean') {
      return c.json(errorBody('validation', 'visible must be boolean'), 400);
    }
    patch.visible = body.visible;
  }
  if (!(await updateCalendar(c.env.DB, id, patch))) {
    return c.json(errorBody('not_found', 'Calendar not found'), 404);
  }
  c.header('Cache-Control', NO_STORE);
  return c.json(await getCalendar(c.env.DB, id));
});
