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
const MAX_PAGES = 10;

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
export async function listCalendarList(env: Env): Promise<GoogleCalendarEntry[]> {
  const token = await getAccessToken(env);
  const out: GoogleCalendarEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string> = { maxResults: String(PAGE_SIZE), showHidden: 'true' };
    if (pageToken) query.pageToken = pageToken;
    let body: unknown;
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
 */
export async function importCalendars(env: Env): Promise<ImportResult> {
  const entries = await listCalendarList(env);
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
            .prepare('UPDATE calendars SET color = ?2 WHERE id = ?1 AND color IS NULL')
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
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
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
  return { added, updated, removed };
}
