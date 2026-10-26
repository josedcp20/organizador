import { CALENDAR_PALETTE } from '@organizador/shared';
import { now } from '../clock';
import { nextPaletteColor } from '../db/calendars';
import type { Env } from '../env';
import { GoogleApiError, googleRequest } from './calendarApi';
import { GoogleAuthError, getAccessToken } from './oauth';

/**
 * Lectura de calendarList (SOLO GET). Usa el access token de `getAccessToken` (refresh e
 * `invalid_grant` ya gestionados alli). Nunca escribe en Google ni registra tokens.
 */
const PAGE_SIZE = 250;
export const MAX_PAGES = 10;

/** job_state: ultimo refresco correcto / ultimo intento fallido del cron (updated_at = instante). */
export const CALENDAR_LIST_OK_KEY = 'calendar_list_ok_at';
export const CALENDAR_LIST_FAIL_KEY = 'calendar_list_fail_at';

export async function markCalendarListState(
  db: D1Database,
  key: string,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO job_state (key, value, updated_at) VALUES (?1, '1', ?2)
       ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .bind(key, new Date(nowMs).toISOString())
    .run();
}

export interface GoogleCalendarEntry {
  id: string;
  summary: string;
  accessRole: string | null;
  selected: boolean;
  backgroundColor: string | null;
}

export { GoogleApiError };

function parseEntry(raw: unknown): GoogleCalendarEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const summary = str(r.summaryOverride) ?? str(r.summary) ?? r.id;
  // `hidden` (oculto en la lista de Google) se trata como no seleccionado.
  const selected = r.selected === true && r.hidden !== true;
  return {
    id: r.id,
    summary,
    accessRole: str(r.accessRole),
    selected,
    backgroundColor: str(r.backgroundColor),
  };
}

/** Un 401, o un 403 insufficientPermissions, indica token/permisos invalidos: se olvida el cache. */
function isAuthRejection(e: unknown): boolean {
  return (
    e instanceof GoogleApiError &&
    (e.status === 401 || (e.status === 403 && e.reason === 'insufficientPermissions'))
  );
}

/** Lista completa (paginada) de calendarios del usuario. Lanza GoogleAuthError o GoogleApiError. */
/** `stats.requests` acumula las peticiones HTTP hechas (token + paginas) para el presupuesto del cron. */
export async function listCalendarList(
  env: Env,
  stats?: { requests: number },
): Promise<GoogleCalendarEntry[]> {
  if (stats) stats.requests = 1; // token (peor caso)
  const token = await getAccessToken(env);
  const out: GoogleCalendarEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string> = { maxResults: String(PAGE_SIZE), showHidden: 'true' };
    if (pageToken) query.pageToken = pageToken;
    let body: unknown;
    if (stats) stats.requests++;
    try {
      body = await googleRequest('GET', 'users/me/calendarList', { token, query });
    } catch (e) {
      if (isAuthRejection(e)) {
        // Descarta el access token cacheado (el siguiente uso lo renueva) y trata como no conectado.
        await env.DB.prepare(
          'UPDATE google_auth SET access_token = NULL, access_token_expires_at = NULL WHERE id = 1',
        ).run();
        throw new GoogleAuthError('not_connected');
      }
      throw e;
    }
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (Array.isArray(b.items)) {
      for (const raw of b.items) {
        const e = parseEntry(raw);
        if (e) out.push(e);
      }
    }
    pageToken =
      typeof b.nextPageToken === 'string' && b.nextPageToken ? b.nextPageToken : undefined;
    if (!pageToken) return out;
  }
  // Demasiadas paginas: mejor fallar que marcar como desaparecidos los que no se leyeron.
  throw new GoogleApiError(502);
}

/**
 * Primer color de la paleta que no usa NINGUN calendario en el momento de escribir (subconsulta
 * evaluada por cada sentencia del batch, que ve las anteriores). Asi no se repite color aunque un
 * PATCH de color o un import concurrente cambien `calendars` entre la lectura y el batch. NULL si
 * no queda ninguno libre (se usa entonces el de rotacion calculado en JS).
 */
const FREE_PALETTE_COLOR_SQL = (() => {
  const values = CALENDAR_PALETTE.map((c, i) => {
    if (!/^#[0-9a-f]{6}$/.test(c)) throw new Error('bad_palette');
    return `('${c}', ${i})`;
  }).join(', ');
  return `(SELECT column1 FROM (VALUES ${values})
    WHERE column1 NOT IN (SELECT lower(color) FROM calendars WHERE color IS NOT NULL)
    ORDER BY column2 LIMIT 1)`;
})();

export interface ImportResult {
  added: number;
  updated: number;
  removed: number;
}

/**
 * Importa calendarList -> tabla `calendars`.
 * - Nuevo: color PROPIO de la paleta (siguiente libre), visible salvo `selected=false` en Google.
 * - Existente: actualiza nombre, rol, color de Google (referencia) y orden; NUNCA `color` ni
 *   `enabled` (decision del usuario).
 * - Desaparecido de Google: `removed_at` (no se borra: events.calendar_id tiene FK).
 *   Seguro tambien en el cron: es reversible (si vuelve, removed_at = NULL), conserva `events` y
 *   sus escrituras pendientes (la cola no mira `calendars`), y una lista truncada falla antes
 *   (MAX_PAGES). Limite conocido: un 200 con lista vacia espuria ocultaria los calendarios hasta
 *   el siguiente refresco (12 h o boton).
 * - Al terminar anota el refresco correcto en job_state (el cron lo usa para espaciar los suyos).
 */
export async function importCalendars(
  env: Env,
  stats?: { requests: number },
): Promise<ImportResult> {
  const entries = await listCalendarList(env, stats);
  const db = env.DB;
  const nowIso = new Date(now()).toISOString();

  const { results: existing } = await db
    .prepare('SELECT id, color, removed_at FROM calendars')
    .all<{ id: string; color: string | null; removed_at: string | null }>();
  const known = new Map(existing.map((r) => [r.id, r]));
  // Tambien los colores de calendarios desaparecidos: si vuelven, conservan su color sin duplicar.
  const usedColors = existing.map((r) => r.color);

  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  entries.forEach((e, i) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    const row = known.get(e.id);
    // Upsert atomico: dos imports concurrentes no chocan en la PK. No toca `color` ni `enabled`
    // de filas existentes (el color/enabled calculados solo se usan al insertar).
    let color: string | null = null;
    if (row) {
      updated++;
      // Fila sin color propio (no deberia ocurrir): se le asigna uno ahora.
      if (!row.color) {
        color = nextPaletteColor(usedColors, usedColors.length);
        usedColors.push(color);
        stmts.push(
          db
            .prepare(
              `UPDATE calendars SET color = COALESCE(${FREE_PALETTE_COLOR_SQL}, ?2)
               WHERE id = ?1 AND color IS NULL`,
            )
            .bind(e.id, color),
        );
      }
    } else {
      color = nextPaletteColor(usedColors, usedColors.length);
      usedColors.push(color);
      added++;
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO calendars (id, summary, google_color, color, enabled, access_role, sort_order)
           VALUES (?1, ?2, ?3, ${row ? '?4' : `COALESCE(${FREE_PALETTE_COLOR_SQL}, ?4)`}, ?5, ?6, ?7)
           ON CONFLICT(id) DO UPDATE SET summary = excluded.summary,
             google_color = excluded.google_color, access_role = excluded.access_role,
             sort_order = excluded.sort_order, removed_at = NULL`,
        )
        .bind(
          e.id,
          e.summary,
          e.backgroundColor,
          color ?? row!.color,
          e.selected ? 1 : 0,
          e.accessRole,
          i,
        ),
    );
  });
  let removed = 0;
  for (const r of existing) {
    if (!seen.has(r.id) && !r.removed_at) {
      removed++;
      stmts.push(
        db.prepare('UPDATE calendars SET removed_at = ?2 WHERE id = ?1').bind(r.id, nowIso),
      );
    }
  }
  if (stmts.length > 0) await db.batch(stmts);
  await markCalendarListState(db, CALENDAR_LIST_OK_KEY, now());
  return { added, updated, removed };
}
