import { CALENDAR_PALETTE, type CalendarInfo } from '@organizador/shared';

interface CalendarRow {
  id: string;
  summary: string;
  google_color: string | null;
  color: string | null;
  enabled: number;
  access_role: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
}

export function isWritableRole(role: string | null): boolean {
  return role === 'owner' || role === 'writer';
}

function toInfo(r: CalendarRow): CalendarInfo {
  return {
    id: r.id,
    name: r.summary,
    color: r.color ?? r.google_color ?? CALENDAR_PALETTE[0],
    visible: r.enabled === 1,
    accessRole: r.access_role,
    writable: isWritableRole(r.access_role),
    lastSyncedAt: r.last_synced_at,
    lastSyncError: r.last_sync_error,
  };
}

const COLS =
  'id, summary, google_color, color, enabled, access_role, last_synced_at, last_sync_error';

/** Calendarios presentes en Google (los desaparecidos quedan en D1 marcados con removed_at). */
export async function listCalendars(db: D1Database): Promise<CalendarInfo[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM calendars WHERE removed_at IS NULL ORDER BY sort_order, summary COLLATE NOCASE, id`,
    )
    .all<CalendarRow>();
  return results.map(toInfo);
}

export async function getCalendar(db: D1Database, id: string): Promise<CalendarInfo | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM calendars WHERE id = ?1 AND removed_at IS NULL`)
    .bind(id)
    .first<CalendarRow>();
  return row ? toInfo(row) : null;
}

/** Actualiza solo color propio y/o visibilidad (solo D1). false si no existe. */
export async function updateCalendar(
  db: D1Database,
  id: string,
  patch: { color?: string; visible?: boolean },
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE calendars SET color = COALESCE(?2, color), enabled = COALESCE(?3, enabled)
       WHERE id = ?1 AND removed_at IS NULL`,
    )
    .bind(id, patch.color ?? null, patch.visible === undefined ? null : patch.visible ? 1 : 0)
    .run();
  return res.meta.changes > 0;
}

/** Siguiente color de la paleta que no usa ningun calendario; si se agotan, rota por cuenta. */
export function nextPaletteColor(used: readonly (string | null)[], taken: number): string {
  const usedSet = new Set(used.filter((c): c is string => !!c).map((c) => c.toLowerCase()));
  const free = CALENDAR_PALETTE.find((c) => !usedSet.has(c));
  return free ?? CALENDAR_PALETTE[taken % CALENDAR_PALETTE.length]!;
}
