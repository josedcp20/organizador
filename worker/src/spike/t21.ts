/**
 * SPIKE T2.1 TEMPORAL. Borrar este archivo (y su enganche en src/index.ts y el test
 * test/spikeT21.test.ts) cuando se haya leido el informe.
 *
 * Se ejecuta UNA sola vez desde el cron (`scheduled`): reclama la clave `spike_t21_done` en
 * `job_state` con un INSERT atomico ANTES de hacer nada (si el Worker muere a mitad no se
 * repite) y deja el informe JSON en `job_state` clave `spike_t21_result`.
 *
 * Reglas de seguridad:
 * - Nunca se guardan ni registran tokens (access/refresh/sync/page) ni titulos/cuerpos de eventos;
 *   solo metadatos, contadores y codigos de error. Los nombres de calendario si van al informe.
 * - No toca `google_auth`: refresca por su cuenta y usa el access token solo en memoria.
 * - Escrituras SOLO en el calendario cuyo summary es exactamente `Organizador pruebas` (owner,
 *   unico). Excepcion: UN intento de insert en un calendario compartido de solo lectura
 *   (reader/freeBusyReader), que Google debe rechazar; si lo aceptara, se borra en el acto.
 * - Presupuesto de subrequests (free tier: 50 por invocacion).
 */
import { now } from '../clock';
import { open } from '../crypto/secretBox';
import type { Env } from '../env';
import { GOOGLE_TOKEN_URL, __test as oauthInternals, loadOAuthConfig } from '../google/oauth';

export const SPIKE_DONE_KEY = 'spike_t21_done';
export const SPIKE_RESULT_KEY = 'spike_t21_result';
export const TEST_CALENDAR_SUMMARY = 'Organizador pruebas';

const CAL = 'https://www.googleapis.com/calendar/v3';
const SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const MAX_SUBREQUESTS = 46;
const FETCH_TIMEOUT_MS = 10_000;
const FIRST_PAGE_SIZE = 5; // pequeno: fuerza paginacion
const NEXT_PAGE_SIZE = 250;
const MAX_PAGES = 6;
const EVENT_FIELDS =
  'nextPageToken,nextSyncToken,items(id,status,etag,recurringEventId,extendedProperties)';
const READONLY_ROLES = new Set(['reader', 'freeBusyReader']);

type Json = Record<string, unknown>;

interface HttpMeta {
  status: number; // 0 = red/timeout o sin presupuesto
  ms: number;
  reasons?: string[];
  errorStatus?: string;
  message?: string;
  skipped?: 'budget';
  network?: string;
}

interface HttpResult {
  meta: HttpMeta;
  json: Json | null;
  etag: string | null;
}

class Ctx {
  used = 0;
  readonly http: { method: string; what: string; status: number }[] = [];
  constructor(readonly token: string) {}

  remaining(): number {
    return MAX_SUBREQUESTS - this.used;
  }

  async call(
    what: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    opts: { body?: unknown; ifMatch?: string; token?: string; force?: boolean } = {},
  ): Promise<HttpResult> {
    if (this.used >= MAX_SUBREQUESTS && !opts.force) {
      return { meta: { status: 0, ms: 0, skipped: 'budget' }, json: null, etag: null };
    }
    this.used++;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token ?? this.token}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      this.http.push({ method, what, status: 0 });
      return {
        meta: { status: 0, ms: Date.now() - t0, network: e instanceof Error ? e.name : 'error' },
        json: null,
        etag: null,
      };
    }
    let json: Json | null = null;
    if (res.status !== 204) {
      try {
        const parsed: unknown = await res.json();
        if (parsed && typeof parsed === 'object') json = parsed as Json;
      } catch {
        json = null;
      }
    }
    this.http.push({ method, what, status: res.status });
    const meta: HttpMeta = { status: res.status, ms: Date.now() - t0 };
    if (!res.ok) Object.assign(meta, errorInfo(json));
    return { meta, json: res.ok ? json : null, etag: res.headers.get('ETag') };
  }
}

/** status/reasons/mensaje de un error de Google (sin cuerpo completo). */
function errorInfo(json: Json | null): Partial<HttpMeta> {
  const err = json?.error;
  if (!err || typeof err !== 'object') {
    // Formato OAuth: { error: 'invalid_grant' }
    return typeof err === 'string' ? { reasons: [err] } : {};
  }
  const e = err as Json;
  const out: Partial<HttpMeta> = {};
  if (Array.isArray(e.errors)) {
    out.reasons = e.errors
      .map((x) => (x && typeof x === 'object' ? (x as Json).reason : undefined))
      .filter((r): r is string => typeof r === 'string');
  }
  if (typeof e.status === 'string') out.errorStatus = e.status;
  if (typeof e.message === 'string') out.message = e.message.slice(0, 200);
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const items = (json: Json | null): Json[] =>
  Array.isArray(json?.items)
    ? (json.items as unknown[]).filter((x): x is Json => !!x && typeof x === 'object')
    : [];

function privateProps(ev: Json | undefined): Json | null {
  const ext = ev?.extendedProperties;
  if (!ext || typeof ext !== 'object') return null;
  const priv = (ext as Json).private;
  return priv && typeof priv === 'object' ? (priv as Json) : null;
}

function eventsUrl(calId: string, params: Record<string, string> = {}): string {
  const u = new URL(`${CAL}/calendars/${encodeURIComponent(calId)}/events`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function eventUrl(calId: string, eventId: string, params: Record<string, string> = {}): string {
  const u = new URL(
    `${CAL}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
  );
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// ---------------------------------------------------------------------------------------------
// Refresh (propio, sin tocar google_auth)

interface RefreshOutcome {
  report: Json;
  accessToken: string | null;
}

async function refresh(
  cfg: { clientId: string; clientSecret: string },
  refreshToken: string,
  scope?: string,
): Promise<RefreshOutcome> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  };
  if (scope) params.scope = scope;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return {
      report: { status: 0, network: e instanceof Error ? e.name : 'error' },
      accessToken: null,
    };
  }
  let body: Json = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') body = parsed as Json;
  } catch {
    body = {};
  }
  const access = str(body.access_token) ?? null;
  return {
    report: {
      status: res.status,
      ms: Date.now() - t0,
      error: str(body.error) ?? null,
      hasScopeField: 'scope' in body,
      scope: str(body.scope) ?? null,
      expiresIn: typeof body.expires_in === 'number' ? body.expires_in : null,
      tokenType: str(body.token_type) ?? null,
      returnedNewRefreshToken: typeof body.refresh_token === 'string',
      hasIdToken: typeof body.id_token === 'string',
      responseKeys: Object.keys(body).sort(),
    },
    accessToken: res.ok && access ? access : null,
  };
}

// ---------------------------------------------------------------------------------------------
// calendarList

interface CalEntry {
  id: string;
  summary: string | null;
  summaryOverride: string | null;
  accessRole: string | null;
  primary: boolean;
  backgroundColor: string | null;
  selected: boolean;
  hidden: boolean;
}

async function listCalendars(
  ctx: Ctx,
  token?: string,
): Promise<{ report: Json; calendars: CalEntry[] }> {
  const calendars: CalEntry[] = [];
  const pages: HttpMeta[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 4; i++) {
    const u = new URL(`${CAL}/users/me/calendarList`);
    u.searchParams.set('maxResults', '250');
    u.searchParams.set(
      'fields',
      'nextPageToken,items(id,summary,summaryOverride,accessRole,primary,backgroundColor,selected,hidden)',
    );
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await ctx.call('calendarList.list', 'GET', u.toString(), token ? { token } : {});
    pages.push(r.meta);
    if (r.meta.status !== 200) break;
    for (const it of items(r.json)) {
      const id = str(it.id);
      if (!id) continue;
      calendars.push({
        id,
        summary: str(it.summary) ?? null,
        summaryOverride: str(it.summaryOverride) ?? null,
        accessRole: str(it.accessRole) ?? null,
        primary: it.primary === true,
        backgroundColor: str(it.backgroundColor) ?? null,
        selected: it.selected === true,
        hidden: it.hidden === true,
      });
    }
    pageToken = str(r.json?.nextPageToken);
    if (!pageToken) break;
  }
  return {
    report: { ok: pages.length > 0 && pages.every((p) => p.status === 200), pages },
    calendars,
  };
}

// ---------------------------------------------------------------------------------------------
// events.list: sync completo con ventana y luego incremental con syncToken

interface FullSync {
  report: Json;
  syncToken: string | null;
}

async function fullSync(
  ctx: Ctx,
  calId: string,
  window: { timeMin: string; timeMax?: string },
): Promise<FullSync> {
  let pageToken: string | undefined;
  let syncToken: string | null = null;
  const pages: { status: number; ms: number; items: number; hasNextPageToken: boolean }[] = [];
  let count = 0;
  let cancelled = 0;
  let instances = 0;
  let withOrganizadorProp = 0;
  let error: HttpMeta | null = null;
  let truncatedBy: 'maxPages' | 'budget' | null = null;
  for (let i = 0; ; i++) {
    if (i >= MAX_PAGES) {
      truncatedBy = 'maxPages';
      break;
    }
    const params: Record<string, string> = {
      singleEvents: 'true',
      showDeleted: 'true',
      timeMin: window.timeMin,
      maxResults: String(i === 0 ? FIRST_PAGE_SIZE : NEXT_PAGE_SIZE),
      fields: EVENT_FIELDS,
    };
    if (window.timeMax) params.timeMax = window.timeMax;
    if (pageToken) params.pageToken = pageToken;
    const r = await ctx.call('events.list(full)', 'GET', eventsUrl(calId, params));
    if (r.meta.skipped) {
      truncatedBy = 'budget';
      break;
    }
    if (r.meta.status !== 200) {
      error = r.meta;
      break;
    }
    const its = items(r.json);
    pageToken = str(r.json?.nextPageToken);
    pages.push({
      status: r.meta.status,
      ms: r.meta.ms,
      items: its.length,
      hasNextPageToken: !!pageToken,
    });
    for (const ev of its) {
      count++;
      if (ev.status === 'cancelled') cancelled++;
      if (typeof ev.recurringEventId === 'string') instances++;
      if (privateProps(ev)?.organizador === '1') withOrganizadorProp++;
    }
    if (!pageToken) {
      syncToken = str(r.json?.nextSyncToken) ?? null;
      break;
    }
  }
  return {
    report: {
      window: { timeMin: window.timeMin, timeMax: window.timeMax ?? null },
      finished: truncatedBy === null && error === null,
      truncatedBy,
      error,
      pages,
      paginated: pages.length > 1,
      events: count,
      cancelled,
      recurringInstances: instances,
      withOrganizadorProp,
      nextSyncTokenReturned: syncToken !== null,
      nextSyncTokenLength: syncToken?.length ?? 0,
    },
    syncToken,
  };
}

interface Incremental {
  report: Json;
  items: Json[];
  syncToken: string | null;
}

async function incremental(
  ctx: Ctx,
  what: string,
  calId: string,
  syncToken: string,
  extra: Record<string, string> = {},
): Promise<Incremental> {
  const r = await ctx.call(
    what,
    'GET',
    eventsUrl(calId, {
      singleEvents: 'true',
      showDeleted: 'true',
      syncToken,
      fields: EVENT_FIELDS,
      ...extra,
    }),
  );
  const its = items(r.json);
  const next = str(r.json?.nextSyncToken) ?? null;
  return {
    report: {
      extraParams: Object.keys(extra),
      ...r.meta,
      items: its.length,
      cancelled: its.filter((e) => e.status === 'cancelled').length,
      hasNextPageToken: typeof r.json?.nextPageToken === 'string',
      nextSyncTokenReturned: next !== null,
    },
    items: its,
    syncToken: next,
  };
}

// ---------------------------------------------------------------------------------------------
// Escrituras (solo calendario de pruebas)

function spikeEventBody(nowMs: number, id?: string): Json {
  // Pasado manana a una hora en punto, 30 min; sin recordatorios para no notificar al movil.
  const start = new Date(Math.ceil((nowMs + 2 * 86_400_000) / 3_600_000) * 3_600_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const body: Json = {
    summary: 'Organizador spike T2.1 (temporal, se borra solo)',
    start: { dateTime: start.toISOString(), timeZone: 'Europe/Madrid' },
    end: { dateTime: end.toISOString(), timeZone: 'Europe/Madrid' },
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { organizador: '1' } },
  };
  if (id) body.id = id;
  return body;
}

/** id propio valido para Google: base32hex en minusculas (a-v, 0-9), 5-1024 caracteres. */
function spikeEventId(): string {
  const hex = [...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `orgspike${hex}`;
}

function eventMeta(ev: Json | null | undefined): Json {
  const priv = privateProps(ev ?? undefined);
  return {
    hasEtag: typeof ev?.etag === 'string',
    eventStatus: str(ev?.status) ?? null,
    extendedPrivate: priv, // solo {organizador:'1'}, puesto por el spike
  };
}

async function writeTests(
  ctx: Ctx,
  calId: string,
  syncToken: string | null,
  nowMs: number,
): Promise<Json> {
  const out: Json = {};
  const id = spikeEventId();
  out.customIdFormat = 'orgspike + 24 hex (base32hex)';
  let inserted = false;
  let deleted = false;
  let token = syncToken;
  try {
    const ins = await ctx.call(
      'events.insert(test)',
      'POST',
      eventsUrl(calId, { sendUpdates: 'none' }),
      { body: spikeEventBody(nowMs, id) },
    );
    // status 0 (timeout/red): el evento podria existir; se intenta limpiar igualmente.
    inserted = ins.meta.status === 200 || (ins.meta.status === 0 && !ins.meta.skipped);
    const etag1 = str(ins.json?.etag) ?? null;
    out.insert = {
      ...ins.meta,
      idHonored: str(ins.json?.id) === id,
      headerEtagMatchesBody: ins.etag !== null && ins.etag === etag1,
      ...eventMeta(ins.json),
    };
    if (!inserted || !etag1) return out;

    const dup = await ctx.call(
      'events.insert(dup id)',
      'POST',
      eventsUrl(calId, { sendUpdates: 'none' }),
      { body: spikeEventBody(nowMs, id) },
    );
    out.insertDuplicateId = dup.meta;

    const p1 = await ctx.call(
      'events.patch(If-Match ok)',
      'PATCH',
      eventUrl(calId, id, { sendUpdates: 'none' }),
      { body: { summary: 'Organizador spike T2.1 (patched)' }, ifMatch: etag1 },
    );
    const etag2 = str(p1.json?.etag) ?? null;
    out.patchIfMatchCurrent = {
      ...p1.meta,
      etagChanged: !!etag2 && etag2 !== etag1,
      ...eventMeta(p1.json),
    };

    const p2 = await ctx.call(
      'events.patch(If-Match stale)',
      'PATCH',
      eventUrl(calId, id, { sendUpdates: 'none' }),
      { body: { summary: 'Organizador spike T2.1 (stale)' }, ifMatch: etag1 },
    );
    out.patchIfMatchStale = p2.meta;

    if (token) {
      const inc = await incremental(ctx, 'events.list(sync echo)', calId, token);
      const mine = inc.items.find((e) => e.id === id);
      out.incrementalEchoAfterWrites = {
        ...inc.report,
        ownEventPresent: !!mine,
        ownEvent: mine ? eventMeta(mine) : null,
      };
      token = inc.syncToken ?? token;
    } else {
      out.incrementalEchoAfterWrites = { skipped: 'no syncToken for test calendar' };
    }

    const byProp = await ctx.call(
      'events.list(privateExtendedProperty)',
      'GET',
      eventsUrl(calId, {
        privateExtendedProperty: 'organizador=1',
        singleEvents: 'true',
        timeMin: new Date(nowMs - 86_400_000).toISOString(),
        fields: 'items(id,etag,status,extendedProperties)',
      }),
    );
    const found = items(byProp.json).find((e) => e.id === id);
    out.listByPrivateExtendedProperty = {
      ...byProp.meta,
      items: items(byProp.json).length,
      ownEventPresent: !!found,
      ownEvent: found ? eventMeta(found) : null,
    };

    const del = await ctx.call(
      'events.delete(If-Match)',
      'DELETE',
      eventUrl(calId, id, { sendUpdates: 'none' }),
      { ifMatch: etag2 ?? etag1 },
    );
    out.deleteIfMatchCurrent = del.meta;
    deleted = del.meta.status === 204 || del.meta.status === 200;
  } finally {
    if (inserted && !deleted) {
      // Limpieza garantizada (sin If-Match). Usa presupuesto reservado.
      const del = await ctx.call(
        'events.delete(cleanup)',
        'DELETE',
        eventUrl(calId, id, { sendUpdates: 'none' }),
        { force: true },
      );
      out.deleteCleanup = del.meta;
      deleted = [200, 204, 404, 410].includes(del.meta.status);
    }
    out.cleanedUp = !inserted || deleted;
  }

  if (inserted && deleted) {
    const again = await ctx.call(
      'events.delete(again)',
      'DELETE',
      eventUrl(calId, id, { sendUpdates: 'none' }),
    );
    out.deleteAgain = again.meta;
    if (token) {
      const inc = await incremental(ctx, 'events.list(sync after delete)', calId, token);
      const mine = inc.items.find((e) => e.id === id);
      out.incrementalAfterDelete = {
        ...inc.report,
        ownEventPresent: !!mine,
        ownEventStatus: str(mine?.status) ?? null,
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Orquestacion

function isSystemCalendar(id: string): boolean {
  return id.endsWith('@group.v.calendar.google.com');
}

function calReport(c: CalEntry): Json {
  return {
    id: c.id,
    summary: c.summary,
    summaryOverride: c.summaryOverride,
    accessRole: c.accessRole,
    primary: c.primary,
    backgroundColor: c.backgroundColor,
    selected: c.selected,
    hidden: c.hidden,
  };
}

export async function runSpike(env: Env, nowMs: number = now()): Promise<Json> {
  const report: Json = { version: 1, startedAt: new Date(nowMs).toISOString() };
  const cfg = await loadOAuthConfig(env);
  if (!cfg) return { ...report, fatal: 'oauth_misconfigured' };
  const row = await oauthInternals.readRow(env.DB);
  if (!row || row.refresh_token_enc === '') return { ...report, fatal: 'google_not_connected' };
  report.storedScope = row.scope;
  let refreshToken: string;
  try {
    refreshToken = await open(cfg.encKey, row.refresh_token_enc, oauthInternals.AAD_REFRESH);
  } catch {
    return { ...report, fatal: 'refresh_token_unreadable' };
  }

  // 1. Refresh: ¿devuelve `scope`?
  const r1 = await refresh(cfg, refreshToken);
  report.refresh = r1.report;
  if (!r1.accessToken) return { ...report, fatal: 'refresh_failed' };
  const ctx = new Ctx(r1.accessToken);
  ctx.used = 1;

  // 2. calendarList con los scopes concedidos.
  const cl = await listCalendars(ctx);
  report.calendarList = { ...cl.report, count: cl.calendars.length };
  report.calendars = cl.calendars.map(calReport);

  // 2b. D11: ¿calendar.events SOLO permite calendarList? (refresh con scope reducido).
  try {
    ctx.used++;
    const r2 = await refresh(cfg, refreshToken, SCOPE_EVENTS);
    const d11: Json = { downscopedRefresh: r2.report };
    if (r2.accessToken) {
      const onlyEvents = await listCalendars(ctx, r2.accessToken);
      d11.calendarListWithEventsOnly = { ...onlyEvents.report, count: onlyEvents.calendars.length };
    }
    report.d11 = d11;
  } catch (e) {
    report.d11 = { error: e instanceof Error ? e.name : 'error' };
  }

  // Ventana D6.
  const minD = new Date(nowMs);
  minD.setUTCMonth(minD.getUTCMonth() - 1);
  const maxD = new Date(nowMs);
  maxD.setUTCMonth(maxD.getUTCMonth() + 12);
  const window = { timeMin: minD.toISOString(), timeMax: maxD.toISOString() };

  // Calendario de pruebas: summary exacto, unico y owner.
  const testCandidates = cl.calendars.filter((c) => c.summary === TEST_CALENDAR_SUMMARY);
  const testCal =
    testCandidates.length === 1 && testCandidates[0]?.accessRole === 'owner'
      ? testCandidates[0]
      : null;
  report.testCalendar = testCal
    ? { id: testCal.id, found: true }
    : {
        found: false,
        candidates: testCandidates.length,
        note: 'sin escrituras: falta, duplicado o no owner',
      };

  const perCalendar: Json[] = [];
  report.perCalendar = perCalendar;

  // 3+4. Calendario de pruebas primero (su syncToken se usa para el eco de escrituras).
  if (testCal) {
    const entry: Json = { id: testCal.id, summary: testCal.summary };
    perCalendar.push(entry);
    try {
      const fs = await fullSync(ctx, testCal.id, window);
      entry.fullSync = fs.report;
      let token = fs.syncToken;
      if (!token && fs.report.finished === true) {
        // Sin nextSyncToken con timeMax: probar solo con timeMin.
        const fs2 = await fullSync(ctx, testCal.id, { timeMin: window.timeMin });
        entry.fullSyncTimeMinOnly = fs2.report;
        token = fs2.syncToken;
      }
      if (token) {
        const a = await incremental(ctx, 'events.list(syncToken a)', testCal.id, token);
        entry.incrementalA = a.report;
        token = a.syncToken ?? token;
        const b = await incremental(ctx, 'events.list(syncToken+timeMin)', testCal.id, token, {
          timeMin: window.timeMin,
        });
        entry.incrementalWithTimeMin = b.report;
        const c = await incremental(ctx, 'events.list(bad syncToken)', testCal.id, `${token}x`);
        entry.incrementalBadToken = c.report;
      }
      try {
        report.writes = await writeTests(ctx, testCal.id, token, nowMs);
      } catch (e) {
        report.writes = { error: e instanceof Error ? e.name : 'error' };
      }
    } catch (e) {
      entry.error = e instanceof Error ? e.name : 'error';
    }
  } else {
    report.writes = { skipped: 'test calendar not found' };
  }

  // 5. Compartido ajeno: accessRole; insert solo si es de solo lectura (Google debe rechazarlo).
  const shared = cl.calendars.filter(
    (c) => !c.primary && c.accessRole !== 'owner' && !isSystemCalendar(c.id),
  );
  report.shared = shared.map((c) => ({ id: c.id, summary: c.summary, accessRole: c.accessRole }));
  const readonlyTarget = shared.find(
    (c) => c.accessRole !== null && READONLY_ROLES.has(c.accessRole),
  );
  if (readonlyTarget && readonlyTarget.id !== testCal?.id) {
    try {
      const att = await ctx.call(
        'events.insert(read-only)',
        'POST',
        eventsUrl(readonlyTarget.id, { sendUpdates: 'none' }),
        { body: spikeEventBody(nowMs) },
      );
      const attempt: Json = {
        calendarId: readonlyTarget.id,
        accessRole: readonlyTarget.accessRole,
        ...att.meta,
      };
      const createdId = str(att.json?.id);
      if (att.meta.status >= 200 && att.meta.status < 300 && createdId) {
        attempt.unexpectedSuccess = true;
        const del = await ctx.call(
          'events.delete(read-only cleanup)',
          'DELETE',
          eventUrl(readonlyTarget.id, createdId, { sendUpdates: 'none' }),
          { force: true },
        );
        attempt.cleanup = del.meta;
      }
      report.readonlyInsertAttempt = attempt;
    } catch (e) {
      report.readonlyInsertAttempt = { error: e instanceof Error ? e.name : 'error' };
    }
  } else {
    report.readonlyInsertAttempt = {
      skipped: shared.length
        ? 'shared calendars are writable: no write attempted'
        : 'no shared calendar',
    };
  }

  // 3. Resto de calendarios: sync completo + incremental (a), con el presupuesto que quede.
  for (const c of cl.calendars) {
    if (c.id === testCal?.id) continue;
    const entry: Json = { id: c.id, summary: c.summary, accessRole: c.accessRole };
    perCalendar.push(entry);
    if (ctx.remaining() < 2) {
      entry.skipped = 'budget';
      continue;
    }
    try {
      const fs = await fullSync(ctx, c.id, window);
      entry.fullSync = fs.report;
      if (fs.syncToken) {
        entry.incrementalA = (
          await incremental(ctx, 'events.list(syncToken a)', c.id, fs.syncToken)
        ).report;
      }
    } catch (e) {
      entry.error = e instanceof Error ? e.name : 'error';
    }
  }

  report.subrequests = { used: ctx.used, max: MAX_SUBREQUESTS };
  report.httpLog = ctx.http;
  report.finishedAt = new Date(now()).toISOString();
  report.wallMs = now() - nowMs;
  return report;
}

async function putState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO job_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, new Date(now()).toISOString())
    .run();
}

/**
 * Ejecuta el spike si no se ha ejecutado nunca. Devuelve true si lo ejecuto en esta llamada.
 * El reclamo es atomico (INSERT ... ON CONFLICT DO NOTHING): como mucho una ejecucion.
 */
export async function runSpikeT21IfPending(env: Env): Promise<boolean> {
  const startedAt = new Date(now()).toISOString();
  const claim = await env.DB.prepare(
    `INSERT INTO job_state (key, value, updated_at) VALUES (?1, 'running', ?2)
     ON CONFLICT(key) DO NOTHING`,
  )
    .bind(SPIKE_DONE_KEY, startedAt)
    .run();
  if (claim.meta.changes !== 1) return false;
  await putState(env.DB, SPIKE_RESULT_KEY, JSON.stringify({ status: 'running', startedAt }));
  let report: Json;
  try {
    report = { status: 'done', ...(await runSpike(env)) };
  } catch (e) {
    report = { status: 'crashed', startedAt, error: e instanceof Error ? e.name : 'error' };
  }
  let serialized = JSON.stringify(report);
  if (serialized.length > 900_000) {
    serialized = JSON.stringify({
      ...report,
      httpLog: 'omitted (size)',
      perCalendar: 'omitted (size)',
    });
  }
  await putState(env.DB, SPIKE_RESULT_KEY, serialized);
  await putState(env.DB, SPIKE_DONE_KEY, 'finished');
  return true;
}
