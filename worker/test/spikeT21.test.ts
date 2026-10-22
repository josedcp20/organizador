// SPIKE T2.1 TEMPORAL: borrar junto con src/spike/t21.ts.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '../src/crypto/encoding';
import type { Env } from '../src/env';
import { GOOGLE_TOKEN_URL, loadOAuthConfig, saveConnection } from '../src/google/oauth';
import worker from '../src/index';
import { SPIKE_DONE_KEY, SPIKE_RESULT_KEY, runSpikeT21IfPending } from '../src/spike/t21';

const rand32 = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const OAUTH_ENV: Partial<Env> = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret-NOT-REAL',
  TOKEN_ENC_KEY: rand32(),
  OAUTH_STATE_KEY: rand32(),
};
const fullEnv = (): Env => ({ ...env, ...OAUTH_ENV }) as Env;

const EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const CALLIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const REFRESH = '1//refresh-SECRET';
const ACCESS = 'ya29.access-SECRET';
const ACCESS_DOWN = 'ya29.down-SECRET';
const SYNC = 'SYNCTOKEN-SECRET';

const PRUEBAS = 'pruebas123@group.calendar.google.com';
const PRIMARY = 'me@example.com';
const SHARED_RO = 'friend@example.com';
const SHARED_W = 'team@group.calendar.google.com';
const HOLIDAY = 'es.spain#holiday@group.v.calendar.google.com';

interface Req {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}
let reqs: Req[];
let hasTestCalendar: boolean;
let failPatch: boolean;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const gErr = (status: number, reason: string) =>
  json({ error: { code: status, message: reason, errors: [{ reason }] } }, status);

function calendarOf(url: URL): string | null {
  const m = /\/calendars\/([^/]+)\/events/.exec(url.pathname);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

let etag = '"e1"';
let deletedOnce = false;

function google(req: Req): Response {
  const { url, method } = req;
  if (url.href === GOOGLE_TOKEN_URL) {
    const p = new URLSearchParams(req.body);
    if (p.get('scope') === EVENTS)
      return json({ access_token: ACCESS_DOWN, expires_in: 3599, scope: EVENTS });
    return json({ access_token: ACCESS, expires_in: 3599, scope: `${EVENTS} ${CALLIST}` });
  }
  if (url.pathname.endsWith('/users/me/calendarList')) {
    if (req.headers.get('Authorization') === `Bearer ${ACCESS_DOWN}`)
      return gErr(403, 'insufficientPermissions');
    const items = [
      { id: PRIMARY, summary: 'Yo', accessRole: 'owner', primary: true, selected: true },
      { id: SHARED_RO, summary: 'Compartido', accessRole: 'reader', selected: true },
      { id: SHARED_W, summary: 'Equipo', accessRole: 'writer' },
      { id: HOLIDAY, summary: 'Festivos', accessRole: 'reader' },
    ];
    if (hasTestCalendar)
      items.push({ id: PRUEBAS, summary: 'Organizador pruebas', accessRole: 'owner' });
    return json({ items });
  }
  const cal = calendarOf(url);
  if (!cal) throw new Error(`fetch inesperado ${method} ${url.href}`);
  const eventId = /\/events\/([^/]+)$/.exec(url.pathname)?.[1];
  if (method === 'GET') {
    const sync = url.searchParams.get('syncToken');
    if (sync) {
      if (url.searchParams.has('timeMin')) return gErr(400, 'invalid');
      if (sync !== SYNC) return gErr(410, 'fullSyncRequired');
      return json({
        items: [
          {
            id: 'orgspikeX',
            status: 'confirmed',
            extendedProperties: { private: { organizador: '1' } },
          },
        ],
        nextSyncToken: SYNC,
      });
    }
    if (url.searchParams.get('privateExtendedProperty')) return json({ items: [] });
    if (!url.searchParams.get('pageToken'))
      return json({ items: [{ id: 'a', status: 'confirmed' }], nextPageToken: 'P2-SECRET' });
    return json({
      items: [{ id: 'b', status: 'cancelled', recurringEventId: 'r' }],
      nextSyncToken: SYNC,
    });
  }
  if (cal !== PRUEBAS) return gErr(403, 'requiredAccessLevel');
  if (method === 'POST') {
    const body = JSON.parse(req.body) as { id: string };
    if (reqs.filter((r) => r.method === 'POST' && calendarOf(r.url) === PRUEBAS).length > 1)
      return gErr(409, 'duplicate');
    return json({ ...body, etag }, 200, { ETag: etag });
  }
  if (method === 'PATCH') {
    if (failPatch) throw new Error('network');
    if (req.headers.get('If-Match') !== etag) return gErr(412, 'conditionNotMet');
    etag = '"e2"';
    return json({ id: eventId, etag, extendedProperties: { private: { organizador: '1' } } });
  }
  if (method === 'DELETE') {
    if (deletedOnce) return gErr(410, 'deleted');
    deletedOnce = true;
    return new Response(null, { status: 204 });
  }
  throw new Error('unexpected');
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM google_auth').run();
  await env.DB.prepare('DELETE FROM job_state').run();
  reqs = [];
  hasTestCalendar = true;
  failPatch = false;
  etag = '"e1"';
  deletedOnce = false;
  const cfg = await loadOAuthConfig(fullEnv());
  if (!cfg) throw new Error('config');
  await saveConnection(
    env.DB,
    cfg,
    { access_token: 'ya29.cached-SECRET', expires_in: 3599, refresh_token: REFRESH },
    [CALLIST, EVENTS],
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const req: Req = {
        method: init?.method ?? 'GET',
        url: new URL(href),
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ''),
      };
      reqs.push(req);
      return google(req);
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function readResult(): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare('SELECT value FROM job_state WHERE key = ?1')
    .bind(SPIKE_RESULT_KEY)
    .first<{ value: string }>();
  expect(row).not.toBeNull();
  for (const s of [REFRESH, ACCESS, ACCESS_DOWN, SYNC, 'P2-SECRET', 'SECRET']) {
    expect(row?.value).not.toContain(s);
  }
  return JSON.parse(row?.value ?? '{}') as Record<string, unknown>;
}

const writes = () => reqs.filter((r) => r.method !== 'GET' && r.url.href !== GOOGLE_TOKEN_URL);

describe('spike T2.1 (temporal)', () => {
  it('se ejecuta una sola vez, escribe solo en pruebas (+1 intento en read-only) y limpia', async () => {
    expect(await runSpikeT21IfPending(fullEnv())).toBe(true);
    const n = reqs.length;
    expect(await runSpikeT21IfPending(fullEnv())).toBe(false);
    expect(reqs.length).toBe(n);

    const w = writes();
    const targets = new Set(w.map((r) => calendarOf(r.url)));
    expect([...targets].sort()).toEqual([SHARED_RO, PRUEBAS].sort());
    expect(w.filter((r) => calendarOf(r.url) === SHARED_RO)).toHaveLength(1);
    for (const r of w) expect(r.url.searchParams.get('sendUpdates')).toBe('none');
    const deletes = w.filter((r) => r.method === 'DELETE' && calendarOf(r.url) === PRUEBAS);
    expect(deletes.length).toBeGreaterThanOrEqual(1);

    const res = await readResult();
    expect(res.status).toBe('done');
    expect(res.refresh).toMatchObject({ hasScopeField: true, status: 200 });
    expect(res.d11).toMatchObject({ calendarListWithEventsOnly: { ok: false } });
    const wr = res.writes as Record<string, Record<string, unknown>>;
    expect(wr.insert).toMatchObject({ status: 200, idHonored: true });
    expect(wr.insertDuplicateId).toMatchObject({ status: 409, reasons: ['duplicate'] });
    expect(wr.patchIfMatchCurrent).toMatchObject({ status: 200 });
    expect(wr.patchIfMatchStale).toMatchObject({ status: 412, reasons: ['conditionNotMet'] });
    expect(wr.deleteIfMatchCurrent).toMatchObject({ status: 204 });
    expect(wr.deleteAgain).toMatchObject({ status: 410 });
    expect(res.writes).toMatchObject({ cleanedUp: true });
    expect(res.readonlyInsertAttempt).toMatchObject({
      calendarId: SHARED_RO,
      status: 403,
      reasons: ['requiredAccessLevel'],
    });
    const done = await env.DB.prepare('SELECT value FROM job_state WHERE key = ?1')
      .bind(SPIKE_DONE_KEY)
      .first<{ value: string }>();
    expect(done?.value).toBe('finished');
  });

  it('sin calendario "Organizador pruebas" no escribe en ningun calendario propio', async () => {
    hasTestCalendar = false;
    await runSpikeT21IfPending(fullEnv());
    const w = writes();
    expect(w.map((r) => calendarOf(r.url))).toEqual([SHARED_RO]);
    const res = await readResult();
    expect(res.testCalendar).toMatchObject({ found: false });
    expect(res.writes).toMatchObject({ skipped: 'test calendar not found' });
  });

  it('borra el evento de prueba aunque falle el patch', async () => {
    failPatch = true;
    await runSpikeT21IfPending(fullEnv());
    const res = await readResult();
    expect(res.writes).toMatchObject({ cleanedUp: true });
    expect(writes().some((r) => r.method === 'DELETE' && calendarOf(r.url) === PRUEBAS)).toBe(true);
  });

  it('el cron lo dispara y no toca google_auth', async () => {
    const before = await env.DB.prepare('SELECT * FROM google_auth').first();
    await worker.scheduled({} as ScheduledController, fullEnv(), {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
    expect(await env.DB.prepare('SELECT * FROM google_auth').first()).toEqual(before);
    expect((await readResult()).status).toBe('done');
  });
});
