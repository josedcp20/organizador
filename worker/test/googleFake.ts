import { env } from 'cloudflare:workers';
import { setClock } from '../src/clock';
import { toBase64Url } from '../src/crypto/encoding';
import type { Env } from '../src/env';
import {
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_URL,
  loadOAuthConfig,
  saveConnection,
} from '../src/google/oauth';

/**
 * Google Calendar falso para tests de escritura (T2.10) y del guardarrail (T2.9): registra TODAS
 * las peticiones salientes (URL, metodo, cabeceras, cuerpo) y simula events.insert/patch/delete/get
 * y events.list con etags de BODY distintos del header ETag (como Google, spike T2.1).
 */

const rand32 = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
export const OAUTH_ENV: Partial<Env> = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret-NOT-REAL',
  GOOGLE_REDIRECT_URI: 'https://organizador-api.jose-dcp20.workers.dev/oauth/google/callback',
  TOKEN_ENC_KEY: rand32(),
  OAUTH_STATE_KEY: rand32(),
};
export const fullEnv = (): Env => ({ ...env, ...OAUTH_ENV }) as Env;
export const ACCESS = 'ya29.access-SECRET';
export const NOW = Date.parse('2026-10-23T10:00:00.000Z');

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
export const gError = (status: number, reason: string) =>
  json({ error: { code: status, errors: [{ reason }], message: reason } }, status);

export interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

type Ev = Record<string, unknown>;
const EVENTS_RE =
  /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/([^/?]+)\/events(?:\/([^/?]+))?(?:\?|$)/;

export class FakeGoogle {
  requests: Captured[] = [];
  /** events por calendario (clave `${cal}/${id}`). */
  store = new Map<string, Ev>();
  /** Respuestas forzadas para las siguientes peticiones a Calendar API (en orden). */
  queue: (Response | Error)[] = [];
  /** Items de calendarList (GET users/me/calendarList). */
  calendarList: Ev[] = [];
  private seq = 1;

  calendarRequests(): Captured[] {
    return this.requests.filter((r) => r.url.startsWith('https://www.googleapis.com/calendar/'));
  }

  put(cal: string, ev: Ev): void {
    this.store.set(`${cal}/${String(ev.id)}`, ev);
  }

  private nextEtag(): string {
    return `"${3_400_000_000_000_000 + this.seq++}"`;
  }

  async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body =
      typeof init?.body === 'string' ? init.body : init?.body == null ? null : '[binary]';
    this.requests.push({ url, method, headers, body });

    if (url === GOOGLE_TOKEN_URL) {
      return json({ access_token: ACCESS, expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') });
    }
    if (url.startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList')) {
      return json({ items: this.calendarList });
    }
    const m = EVENTS_RE.exec(url);
    if (!m) throw new Error(`fetch inesperado a ${url}`);
    const forced = this.queue.shift();
    if (forced instanceof Error) throw forced;
    if (forced) return forced;
    if (headers.authorization !== `Bearer ${ACCESS}`) return gError(401, 'authError');

    const cal = decodeURIComponent(m[1]!);
    const id = m[2] ? decodeURIComponent(m[2]) : null;
    const key = `${cal}/${id}`;
    const nowIso = new Date(NOW).toISOString();
    const headerEtag = { ETag: `"header-etag-${this.seq}"` };

    if (method === 'GET' && !id) {
      const items = [...this.store.entries()]
        .filter(([k]) => k.startsWith(`${cal}/`))
        .map(([, v]) => v);
      return json({ items, nextSyncToken: `sync-${this.seq++}` });
    }
    if (method === 'GET') {
      const ev = this.store.get(key);
      return ev ? json(ev, 200, headerEtag) : gError(404, 'notFound');
    }
    if (method === 'POST' && !id) {
      const b = JSON.parse(body ?? '{}') as Ev;
      const k = `${cal}/${String(b.id)}`;
      if (this.store.has(k)) return gError(409, 'duplicate');
      const ev: Ev = {
        kind: 'calendar#event',
        ...b,
        status: 'confirmed',
        etag: this.nextEtag(),
        updated: nowIso,
        htmlLink: `https://www.google.com/calendar/event?eid=${String(b.id)}`,
      };
      this.store.set(k, ev);
      return json(ev, 200, headerEtag);
    }
    if (method === 'PATCH' && id) {
      const ev = this.store.get(key);
      if (!ev) return gError(404, 'notFound');
      if (ev.status === 'cancelled') return gError(410, 'deleted');
      if (headers['if-match'] !== ev.etag) return gError(412, 'conditionNotMet');
      const b = JSON.parse(body ?? '{}') as Ev;
      const next: Ev = { ...ev, ...b, etag: this.nextEtag(), updated: nowIso };
      this.store.set(key, next);
      return json(next, 200, headerEtag);
    }
    if (method === 'DELETE' && id) {
      const ev = this.store.get(key);
      if (!ev) return gError(404, 'notFound');
      if (ev.status === 'cancelled') return gError(410, 'deleted');
      if (headers['if-match'] !== ev.etag) return gError(412, 'conditionNotMet');
      this.store.set(key, { id, status: 'cancelled', etag: this.nextEtag(), updated: nowIso });
      return new Response(null, { status: 204 });
    }
    throw new Error(`metodo inesperado ${method}`);
  }
}

export async function connect(): Promise<void> {
  const cfg = (await loadOAuthConfig(fullEnv()))!;
  await saveConnection(
    env.DB,
    cfg,
    { access_token: ACCESS, expires_in: 3600, refresh_token: '1//refresh-SECRET' },
    [...GOOGLE_SCOPES],
    NOW,
  );
}

export async function addCalendar(
  id: string,
  role: string | null = 'owner',
  extra: { removed_at?: string; color?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO calendars (id, summary, color, enabled, access_role, removed_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?5)`,
  )
    .bind(id, `Cal ${id}`, extra.color ?? '#1a73e8', role, extra.removed_at ?? null)
    .run();
}

export async function resetDb(): Promise<void> {
  for (const t of [
    'events',
    'event_meta',
    'notes',
    'settings',
    'calendars',
    'google_auth',
    'job_state',
  ]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  setClock(() => NOW);
}
