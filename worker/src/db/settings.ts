import { isHexColor, type AppSettings } from '@organizador/shared';
import { now } from '../clock';
import { isWritableRole } from './calendars';

/**
 * Ajustes de la app (tabla `settings`, clave/valor). SOLO D1: nunca se envian a Google.
 * - app_events_color: #rrggbb de los eventos creados en la app (lo usa db/eventsRead.ts).
 * - default_write_calendar: calendario preseleccionado al crear (writable y presente en Google).
 */

export const SETTING_KEYS = ['app_events_color', 'default_write_calendar'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Calendario valido como destino de escritura: presente en Google y con rol owner/writer. */
export async function isWritableCalendar(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT access_role FROM calendars WHERE id = ?1 AND removed_at IS NULL')
    .bind(id)
    .first<{ access_role: string | null }>();
  return !!row && isWritableRole(row.access_role);
}

/**
 * Ajustes efectivos. Un valor guardado que ya no es valido (color corrupto, calendario que dejo de
 * ser writable o desaparecio) se devuelve como null, sin borrarlo.
 */
export async function getSettings(db: D1Database): Promise<AppSettings> {
  const { results } = await db
    .prepare(
      `SELECT key, value FROM settings WHERE key IN ('app_events_color', 'default_write_calendar')`,
    )
    .all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const color = map.get('app_events_color');
  const cal = map.get('default_write_calendar');
  return {
    app_events_color: isHexColor(color) ? color.toLowerCase() : null,
    default_write_calendar: cal && (await isWritableCalendar(db, cal)) ? cal : null,
  };
}

/** Guarda (valor) o borra (null) los ajustes indicados en una transaccion. */
export async function saveSettings(
  db: D1Database,
  patch: Partial<Record<SettingKey, string | null>>,
): Promise<void> {
  const ts = new Date(now()).toISOString();
  const stmts = Object.entries(patch).map(([key, value]) =>
    value === null || value === undefined
      ? db.prepare('DELETE FROM settings WHERE key = ?1').bind(key)
      : db
          .prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind(key, value, ts),
  );
  if (stmts.length) await db.batch(stmts);
}
