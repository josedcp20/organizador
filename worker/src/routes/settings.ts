import { isHexColor } from '@organizador/shared';
import { Hono } from 'hono';
import {
  getSettings,
  isWritableCalendar,
  saveSettings,
  SETTING_KEYS,
  type SettingKey,
} from '../db/settings';
import type { Env } from '../env';
import { errorBody } from '../errors';

/**
 * Ajustes (T3.7): `GET/PATCH /api/settings`. Protegido por el middleware Bearer de /api/*.
 * SOLO D1: ninguna ruta de aqui llama a Google.
 */
export const settings = new Hono<{ Bindings: Env }>();

const NO_STORE = 'no-store';
const MAX_CALENDAR_ID = 1024;

settings.get('/api/settings', async (c) => {
  c.header('Cache-Control', NO_STORE);
  return c.json(await getSettings(c.env.DB));
});

settings.patch('/api/settings', async (c) => {
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
  if (keys.length === 0 || keys.some((k) => !(SETTING_KEYS as readonly string[]).includes(k))) {
    return c.json(
      errorBody('validation', 'Only app_events_color and default_write_calendar are allowed'),
      400,
    );
  }
  const patch: Partial<Record<SettingKey, string | null>> = {};
  if ('app_events_color' in body) {
    const v = body.app_events_color;
    if (v !== null && !isHexColor(v)) {
      return c.json(errorBody('validation', 'app_events_color must be #rrggbb or null'), 400);
    }
    patch.app_events_color = v === null ? null : v.toLowerCase();
  }
  if ('default_write_calendar' in body) {
    const v = body.default_write_calendar;
    if (v !== null) {
      if (typeof v !== 'string' || !v || v.length > MAX_CALENDAR_ID) {
        return c.json(
          errorBody('validation', 'default_write_calendar must be a string or null'),
          400,
        );
      }
      if (!(await isWritableCalendar(c.env.DB, v))) {
        return c.json(
          errorBody('validation', 'default_write_calendar must be a writable calendar'),
          400,
        );
      }
    }
    patch.default_write_calendar = v as string | null;
  }
  await saveSettings(c.env.DB, patch);
  c.header('Cache-Control', NO_STORE);
  return c.json(await getSettings(c.env.DB));
});
