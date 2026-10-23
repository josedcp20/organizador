import type { SyncResult } from '@organizador/shared';
import { now } from '../clock';
import { acquireLock, heartbeat, lockFence, releaseLock, type JobLock } from '../db/jobLock';
import type { Env } from '../env';
import { GoogleApiError, listEventsPage } from '../google/calendarApi';
import { GoogleAuthError, forgetAccessToken, getAccessToken } from '../google/oauth';
import { parseGoogleEvent, type ParsedEvent } from './parse';
import { DEFAULT_TZ, localDay, syncWindow, type SyncWindow } from './window';

/**
 * Motor de sync Google -> D1 (SOLO LECTURA de Google: `events.list`). Por calendario visible
 * (`enabled = 1`) y presente en Google (`removed_at IS NULL`); los ocultos no se sincronizan hasta
 * que se vuelven a activar (al activarse, su primera pasada del dia es completa).
 *
 * Pasadas (resultados del spike T2.1, cierra D7 con la Opcion A + resync completo diario):
 * - COMPLETA: singleEvents=true, showDeleted=true, timeMin=hoy-1 mes, timeMax=hoy+12 meses,
 *   maxResults=250, paginada. Termina con `nextSyncToken`. Al acabar borra las filas de la ventana
 *   que Google ya no devuelve (borrados cuyo "cancelled" se perdio, p. ej. tras un 410).
 * - INCREMENTAL: SOLO syncToken (+pageToken): con timeMin/timeMax Google da 400
 *   `syncTokenWithRequestRestrictions`. La ventana se aplica al ingerir.
 * - 410 o 400 (token/pageToken invalido) -> se descarta el token y se hace la pasada completa.
 * - Resync completo DIARIO (D7): si la ultima completa no es de hoy (Madrid), la siguiente pasada
 *   es completa. Asi entran los eventos/instancias que llegan al horizonte +12 meses (el incremental
 *   solo trae cambios, no lo que "entra" en la ventana al rodar) y se purgan borrados perdidos.
 *
 * Reglas de ingesta (D6, D10):
 * - Inicio anterior a la ventana: fila CONGELADA. El sync no la actualiza ni la borra, y no inserta
 *   eventos nuevos que empiecen antes de la ventana.
 * - Inicio >= hoy+12 meses: no se guarda (y si la fila existia, se borra: el evento se movio).
 * - `cancelled` -> se BORRA la fila de `events`. `event_meta` (notas, avisar, color) NO se toca:
 *   no tiene FK con events y su clave es (calendar_id, scope, id de Google), asi que si el
 *   cancelado era transitorio (deshacer en Google, instancia restaurada) el evento vuelve con el
 *   mismo id y recupera sus datos privados; si no vuelve, la meta queda huerfana visible en Ajustes
 *   (T3.x). Nunca se pierden datos privados por un cancelado.
 * - Filas con `pending_op` (escritura de la app sin confirmar) nunca se sobrescriben ni se borran.
 * - Upsert por (calendar_id, id); etag del BODY; sin cambios de etag no se reescribe la fila.
 * - `extendedProperties.private.organizadorId` -> origin='app' (+ local_id si no choca con otra fila).
 *
 * Limites (free tier: 50 subrequests y ~10 ms CPU por invocacion):
 * - Presupuesto de peticiones a Google por ejecucion (`maxRequests`). Cada pagina se confirma en
 *   UN batch de D1 (eventos + cursor), asi que si se corta se reanuda en la siguiente ejecucion
 *   desde la ultima pagina confirmada y el calendario nunca queda con el token a medias: el
 *   `sync_token` solo se sustituye en el batch de la ultima pagina.
 * - Primero los calendarios que solo necesitan incremental (1 peticion), luego las completas.
 * - Lock con lease en job_state ('sync_lock'): dos ejecuciones no se solapan; todas las
 *   escrituras van valladas por el lock (si otro lo tomo tras expirar el lease, no se escribe nada).
 * - Errores aislados por calendario con backoff exponencial; 403 de cuota / 429 cortan la ejecucion
 *   (la cuota es por usuario). 401 -> se olvida el access token y se corta. Google desconectado
 *   (invalid_grant, etc.) -> no se sincroniza, sin ruido.
 * Logs: solo codigos y contadores (nunca ids de calendario, que son emails, ni datos de eventos).
 */

export const SYNC_LOCK_KEY = 'sync_lock';
export const SYNC_LOCK_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_REQUESTS = 10;
export const PAGE_SIZE = 250;
const BACKOFF_BASE_MS = 10 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

export interface SyncOptions {
  /** Maximo de peticiones a Calendar API en esta ejecucion (por defecto DEFAULT_MAX_REQUESTS). */
  maxRequests?: number;
  nowMs?: number;
}

interface CalendarRow {
  id: string;
  sync_token: string | null;
  sync_cursor: string | null;
  last_synced_at: string | null;
  last_full_sync_at: string | null;
  sync_failures: number;
}

interface Cursor {
  v: 1;
  phase: 'full' | 'incremental';
  pageToken?: string;
  /** Solo en fase full: inicio (ISO) de la pasada y ventana fijada al empezarla. */
  run?: string;
  window?: SyncWindow;
}

class LockLostError extends Error {
  constructor() {
    super('sync_lock_lost');
    this.name = 'LockLostError';
  }
}

interface RunCtx {
  env: Env;
  db: D1Database;
  lock: JobLock;
  token: string;
  tz: string;
  nowMs: number;
  nowIso: string;
  budget: number;
  result: SyncResult;
}

const emptyResult = (status: SyncResult['status']): SyncResult => ({
  status,
  calendars: 0,
  completed: 0,
  partial: 0,
  failed: 0,
  requests: 0,
  upserted: 0,
  deleted: 0,
});

function parseCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<Cursor>;
    if (c?.v !== 1 || (c.phase !== 'full' && c.phase !== 'incremental')) return null;
    if (c.pageToken !== undefined && typeof c.pageToken !== 'string') return null;
    if (c.phase === 'full') {
      const w = c.window;
      if (typeof c.run !== 'string' || !w || typeof w.timeMin !== 'string') return null;
      if (typeof w.timeMax !== 'string' || typeof w.startDate !== 'string') return null;
      if (typeof w.endDate !== 'string') return null;
    }
    return c as Cursor;
  } catch {
    return null;
  }
}

function needsFull(cal: CalendarRow, today: string, tz: string): boolean {
  return !cal.sync_token || localDay(cal.last_full_sync_at, tz) !== today;
}

function newFullCursor(ctx: RunCtx): Cursor {
  return { v: 1, phase: 'full', run: ctx.nowIso, window: syncWindow(ctx.nowMs, ctx.tz) };
}

export function backoffMs(failures: number, rand: number = Math.random()): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
  return Math.round(base * (1 + 0.2 * rand));
}

// ---------------------------------------------------------------------------------------------
// SQL (todas valladas por el lock: ?N = lock.owner)

const fence = (n: number) => lockFence(SYNC_LOCK_KEY, n);

/** Fila existente congelada: inicio anterior a la ventana (NULL cuenta como congelada). */
const frozen = (p: string, nDate: number, nIso: number) =>
  `(CASE WHEN ${p}all_day = 1 THEN COALESCE(${p}start_date, '') < ?${nDate} ` +
  `ELSE COALESCE(${p}start_at, '') < ?${nIso} END)`;

const EVENT_COLS =
  'calendar_id, id, recurring_event_id, status, summary, location, description, all_day, ' +
  'start_at, end_at, start_date, end_date, html_link, updated, etag, original_start, origin, ' +
  'local_id, sync_run';

/** local_id = organizadorId salvo que ya lo tenga OTRA fila (indice unico: caso anomalo copiado). */
const LOCAL_ID_EXPR =
  'CASE WHEN ?18 IS NULL OR EXISTS (SELECT 1 FROM events e2 WHERE e2.local_id = ?18 ' +
  'AND NOT (e2.calendar_id = ?1 AND e2.id = ?2)) THEN NULL ELSE ?18 END';

const UPSERT_SQL = `INSERT INTO events (${EVENT_COLS})
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ${LOCAL_ID_EXPR}, ?19
  WHERE ${fence(20)}
  ON CONFLICT(calendar_id, id) DO UPDATE SET
    recurring_event_id = excluded.recurring_event_id, status = excluded.status,
    summary = excluded.summary, location = excluded.location, description = excluded.description,
    all_day = excluded.all_day, start_at = excluded.start_at, end_at = excluded.end_at,
    start_date = excluded.start_date, end_date = excluded.end_date, html_link = excluded.html_link,
    updated = excluded.updated, etag = excluded.etag, original_start = excluded.original_start,
    origin = CASE WHEN excluded.origin = 'app' THEN 'app' ELSE events.origin END,
    local_id = COALESCE(events.local_id, excluded.local_id),
    sync_run = COALESCE(excluded.sync_run, events.sync_run)
  WHERE events.pending_op IS NULL
    AND (events.etag IS NOT excluded.etag
         OR (excluded.sync_run IS NOT NULL AND events.sync_run IS NOT excluded.sync_run))`;

/** Evento que ahora empieza antes de la ventana: solo actualiza una fila existente NO congelada. */
const UPDATE_PAST_SQL = `UPDATE events SET
    recurring_event_id = ?3, status = ?4, summary = ?5, location = ?6, description = ?7,
    all_day = ?8, start_at = ?9, end_at = ?10, start_date = ?11, end_date = ?12, html_link = ?13,
    updated = ?14, etag = ?15, original_start = ?16,
    origin = CASE WHEN ?17 = 'app' THEN 'app' ELSE origin END,
    local_id = COALESCE(local_id, ${LOCAL_ID_EXPR}),
    sync_run = COALESCE(?19, sync_run)
  WHERE calendar_id = ?1 AND id = ?2 AND pending_op IS NULL
    AND NOT ${frozen('', 21, 22)} AND ${fence(20)}`;

const DELETE_ONE_SQL = `DELETE FROM events
  WHERE calendar_id = ?1 AND id = ?2 AND pending_op IS NULL AND NOT ${frozen('', 3, 4)}
    AND ${fence(5)}`;

/** Fin de pasada completa: borra lo que estaba en la ventana y Google ya no devuelve. */
const PURGE_UNSEEN_SQL = `DELETE FROM events
  WHERE calendar_id = ?1 AND pending_op IS NULL
    AND (sync_run IS NULL OR sync_run <> ?2)
    AND (updated IS NULL OR updated < ?2)
    AND (CASE WHEN all_day = 1 THEN COALESCE(start_date, '') >= ?3 AND start_date < ?4
         ELSE COALESCE(start_at, '') >= ?5 AND start_at < ?6 END)
    AND ${fence(7)}`;

const SAVE_CURSOR_SQL = `UPDATE calendars SET sync_cursor = ?2 WHERE id = ?1 AND ${fence(3)}`;

const FINISH_SQL = `UPDATE calendars SET sync_cursor = NULL, sync_token = ?2, last_synced_at = ?3,
    last_full_sync_at = COALESCE(?4, last_full_sync_at), last_sync_error = NULL,
    last_sync_error_at = NULL, sync_failures = 0, sync_backoff_until = NULL
  WHERE id = ?1 AND ${fence(5)}`;

const RESET_TOKEN_SQL = `UPDATE calendars SET sync_token = NULL, sync_cursor = NULL
  WHERE id = ?1 AND ${fence(2)}`;

const RECORD_ERROR_SQL = `UPDATE calendars SET last_sync_error = ?2, last_sync_error_at = ?3,
    sync_failures = sync_failures + 1, sync_backoff_until = ?4
  WHERE id = ?1 AND ${fence(5)}`;

function eventParams(calId: string, e: ParsedEvent, run: string | null, owner: string): unknown[] {
  return [
    calId,
    e.id,
    e.recurringEventId,
    e.status,
    e.summary,
    e.location,
    e.description,
    e.allDay ? 1 : 0,
    e.startAt,
    e.endAt,
    e.startDate,
    e.endDate,
    e.htmlLink,
    e.updated,
    e.etag,
    e.originalStart,
    e.organizadorId ? 'app' : 'google',
    e.organizadorId,
    run,
    owner,
  ];
}

type Placement = 'before' | 'inside' | 'after';

function placement(e: ParsedEvent, w: SyncWindow): Placement {
  const key = e.allDay ? e.startDate! : e.startAt!;
  const [lo, hi] = e.allDay ? [w.startDate, w.endDate] : [w.timeMin, w.timeMax];
  if (key < lo) return 'before';
  if (key >= hi) return 'after';
  return 'inside';
}

// ---------------------------------------------------------------------------------------------

function errorCode(e: unknown): string {
  if (e instanceof GoogleApiError) {
    if (e.status === 0) return 'network';
    if (e.status === 403 && e.reason && RATE_LIMIT_REASONS.has(e.reason)) return 'rate_limited';
    if (e.status === 429) return 'rate_limited';
    if (e.status === 403) return 'forbidden';
    if (e.status === 404) return 'not_found';
    if (e.status === 410) return 'sync_reset_failed';
    if (e.status === 400) return 'bad_request';
    if (e.status >= 500) return 'google_5xx';
    return `http_${e.status}`;
  }
  if (e instanceof BadResponse) return 'bad_response';
  return 'internal';
}

class BadResponse extends Error {
  constructor() {
    super('bad_response');
    this.name = 'BadResponse';
  }
}

function isAuthRejection(e: unknown): boolean {
  return (
    e instanceof GoogleApiError &&
    (e.status === 401 || (e.status === 403 && e.reason === 'insufficientPermissions'))
  );
}

type Tagged = { stmt: D1PreparedStatement; kind: 'upsert' | 'delete' | 'other' };

async function runBatch(ctx: RunCtx, stmts: Tagged[]): Promise<void> {
  // El ultimo statement es siempre el UPDATE de calendars vallado: si no cambio nada, el lock ya
  // no es nuestro (y por la valla nada del batch se escribio).
  const res = await ctx.db.batch([heartbeat(ctx.db, ctx.lock, now()), ...stmts.map((t) => t.stmt)]);
  if ((res[res.length - 1]?.meta.changes ?? 0) !== 1) throw new LockLostError();
  stmts.forEach((t, i) => {
    const changes = res[i + 1]?.meta.changes ?? 0;
    if (t.kind === 'upsert') ctx.result.upserted += changes;
    else if (t.kind === 'delete') ctx.result.deleted += changes;
  });
}

/** Sincroniza un calendario hasta terminar o agotar presupuesto. */
async function syncCalendar(ctx: RunCtx, cal: CalendarRow): Promise<'done' | 'partial'> {
  const { db, lock } = ctx;
  const today = syncWindow(ctx.nowMs, ctx.tz).today;
  let cursor = parseCursor(cal.sync_cursor);
  // Pasada completa empezada otro dia (p. ej. calendario ocultado a medias): su ventana y sus
  // pageToken ya no valen; se empieza de nuevo con la ventana de hoy.
  if (cursor?.phase === 'full' && localDay(cursor.run ?? null, ctx.tz) !== today) cursor = null;
  let syncToken = cal.sync_token;
  if (!cursor) {
    cursor =
      needsFull(cal, today, ctx.tz) || !syncToken
        ? newFullCursor(ctx)
        : { v: 1, phase: 'incremental' };
  }
  if (cursor.phase === 'incremental' && !syncToken) cursor = newFullCursor(ctx);
  let resets = 0;

  for (;;) {
    if (ctx.budget <= 0) return 'partial';
    const full = cursor.phase === 'full';
    const query: Record<string, string> = {
      singleEvents: 'true',
      showDeleted: 'true',
      maxResults: String(PAGE_SIZE),
    };
    if (full) {
      query.timeMin = cursor.window!.timeMin;
      query.timeMax = cursor.window!.timeMax;
    } else {
      query.syncToken = syncToken!;
    }
    if (cursor.pageToken) query.pageToken = cursor.pageToken;

    ctx.budget--;
    ctx.result.requests++;
    let body: unknown;
    try {
      body = await listEventsPage(ctx.token, cal.id, query);
    } catch (e) {
      const tokenish = !full || !!cursor.pageToken;
      if (
        e instanceof GoogleApiError &&
        (e.status === 410 || e.status === 400) &&
        tokenish &&
        resets === 0
      ) {
        // syncToken caducado/invalido (410 fullSyncRequired, 400 invalid) o pageToken caducado.
        console.warn('sync', 'token_reset', e.status, e.reason ?? '');
        resets++;
        const r = await db.prepare(RESET_TOKEN_SQL).bind(cal.id, lock.owner).run();
        if (r.meta.changes !== 1) throw new LockLostError();
        syncToken = null;
        cursor = newFullCursor(ctx);
        continue;
      }
      throw e;
    }

    const b = (body && typeof body === 'object' ? body : null) as Record<string, unknown> | null;
    if (!b) throw new BadResponse();
    const items = Array.isArray(b.items) ? b.items : [];
    const nextPage =
      typeof b.nextPageToken === 'string' && b.nextPageToken ? b.nextPageToken : null;
    const nextSync =
      typeof b.nextSyncToken === 'string' && b.nextSyncToken ? b.nextSyncToken : null;
    if (!nextPage && !nextSync) throw new BadResponse();

    // Ventana: la de la pasada completa (fija entre paginas) o la de hoy para el incremental.
    const w = full ? cursor.window! : syncWindow(ctx.nowMs, ctx.tz);
    const run = full ? cursor.run! : null;
    const stmts: Tagged[] = [];
    const del = (id: string) =>
      stmts.push({
        stmt: db.prepare(DELETE_ONE_SQL).bind(cal.id, id, w.startDate, w.timeMin, lock.owner),
        kind: 'delete',
      });
    for (const raw of items) {
      const item = parseGoogleEvent(raw);
      if (item.kind === 'invalid') continue;
      if (item.kind === 'cancelled') {
        del(item.id);
        continue;
      }
      const ev = item.event;
      const where = placement(ev, w);
      if (where === 'after') {
        del(ev.id); // fuera del horizonte: no se guarda (si existia, se movio alli)
        continue;
      }
      const params = eventParams(cal.id, ev, run, lock.owner);
      stmts.push({
        stmt:
          where === 'inside'
            ? db.prepare(UPSERT_SQL).bind(...params)
            : db.prepare(UPDATE_PAST_SQL).bind(...params, w.startDate, w.timeMin),
        kind: 'upsert',
      });
    }

    if (nextPage) {
      const next: Cursor = { ...cursor, pageToken: nextPage };
      stmts.push({
        stmt: db.prepare(SAVE_CURSOR_SQL).bind(cal.id, JSON.stringify(next), lock.owner),
        kind: 'other',
      });
      await runBatch(ctx, stmts);
      cursor = next;
      continue;
    }

    if (full) {
      stmts.push({
        stmt: db
          .prepare(PURGE_UNSEEN_SQL)
          .bind(cal.id, run, w.startDate, w.endDate, w.timeMin, w.timeMax, lock.owner),
        kind: 'delete',
      });
    }
    stmts.push({
      stmt: db.prepare(FINISH_SQL).bind(cal.id, nextSync, ctx.nowIso, run, lock.owner),
      kind: 'other',
    });
    await runBatch(ctx, stmts);
    return 'done';
  }
}

async function recordError(ctx: RunCtx, cal: CalendarRow, code: string): Promise<void> {
  const failures = (cal.sync_failures ?? 0) + 1;
  const until = new Date(ctx.nowMs + backoffMs(failures)).toISOString();
  try {
    await ctx.db
      .prepare(RECORD_ERROR_SQL)
      .bind(cal.id, code, ctx.nowIso, until, ctx.lock.owner)
      .run();
  } catch (e) {
    console.error('sync', 'record_error_failed', e instanceof Error ? e.name : 'unknown');
  }
}

/** Calendarios a sincronizar, en orden: incrementales (baratos) primero, luego los mas antiguos. */
async function candidates(db: D1Database, nowIso: string): Promise<CalendarRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, sync_token, sync_cursor, last_synced_at, last_full_sync_at, sync_failures
       FROM calendars
       WHERE removed_at IS NULL AND enabled = 1
         AND (sync_backoff_until IS NULL OR sync_backoff_until <= ?1)
       ORDER BY COALESCE(last_synced_at, '') ASC, sort_order, id`,
    )
    .bind(nowIso)
    .all<CalendarRow>();
  return results;
}

/**
 * Una ejecucion de sync (cron o POST /api/sync). Nunca lanza por errores de Google o de un
 * calendario concreto; devuelve contadores.
 */
export async function runSync(env: Env, opts: SyncOptions = {}): Promise<SyncResult> {
  const db = env.DB;
  const nowMs = opts.nowMs ?? now();
  const nowIso = new Date(nowMs).toISOString();
  const tz = env.TZ || DEFAULT_TZ;

  const lock = await acquireLock(db, SYNC_LOCK_KEY, SYNC_LOCK_TTL_MS, nowMs);
  if (!lock) return emptyResult('busy');
  try {
    const cals = await candidates(db, nowIso);
    const result = emptyResult('ok');
    result.calendars = cals.length;
    if (cals.length === 0) return result;

    let token: string;
    try {
      token = await getAccessToken(env, nowMs);
    } catch (e) {
      if (e instanceof GoogleAuthError) {
        // Desconectado / mal configurado: no se sincroniza y no es un fallo del cron.
        const status =
          e.code === 'misconfigured'
            ? 'misconfigured'
            : e.code === 'unavailable'
              ? 'unavailable'
              : 'not_connected';
        return { ...emptyResult(status), calendars: cals.length };
      }
      throw e;
    }

    const today = syncWindow(nowMs, tz).today;
    const isFull = (c: CalendarRow) =>
      parseCursor(c.sync_cursor)?.phase === 'full' || needsFull(c, today, tz);
    const ordered = [...cals.filter((c) => !isFull(c)), ...cals.filter(isFull)];

    const ctx: RunCtx = {
      env,
      db,
      lock,
      token,
      tz,
      nowMs,
      nowIso,
      budget: Math.max(0, Math.floor(opts.maxRequests ?? DEFAULT_MAX_REQUESTS)),
      result,
    };

    for (const cal of ordered) {
      if (ctx.budget <= 0) {
        result.partial++;
        continue;
      }
      try {
        const r = await syncCalendar(ctx, cal);
        if (r === 'done') result.completed++;
        else result.partial++;
      } catch (e) {
        if (e instanceof LockLostError) {
          console.warn('sync', 'lock_lost');
          break;
        }
        if (isAuthRejection(e)) {
          await forgetAccessToken(db);
          console.warn('sync', 'auth_rejected');
          result.status = 'auth_rejected';
          result.failed++;
          break;
        }
        const code = errorCode(e);
        result.failed++;
        console.warn(
          'sync',
          'calendar_error',
          code,
          e instanceof GoogleApiError ? e.status : '',
          e instanceof GoogleApiError ? (e.reason ?? '') : e instanceof Error ? e.name : '',
        );
        await recordError(ctx, cal, code);
        if (code === 'rate_limited') break; // cuota por usuario: no insistir con el resto
      }
    }
    console.log(
      'sync',
      'summary',
      JSON.stringify({
        calendars: result.calendars,
        completed: result.completed,
        partial: result.partial,
        failed: result.failed,
        requests: result.requests,
      }),
    );
    return result;
  } finally {
    try {
      await releaseLock(db, lock);
    } catch {
      // El lease caduca solo.
    }
  }
}

export const __test = { parseCursor, needsFull };
