import { GOOGLE_CONNECT_REASONS } from '@organizador/shared';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock';
import { toBase64Url } from '../src/crypto/encoding';
import type { Env } from '../src/env';
import {
  ACCESS_TOKEN_MARGIN_MS,
  GOOGLE_REVOKE_URL,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_URL,
  GoogleAuthError,
  checkScopes,
  getAccessToken,
  loadOAuthConfig,
  saveConnection,
} from '../src/google/oauth';
import { type CallOptions, call as rawCall, clearFailures } from './helpers';

// IP fija: el middleware exige CF-Connecting-IP fuera de ENV=dev.
const call = (path: string, opts: CallOptions = {}) =>
  rawCall(path, { ip: '203.0.113.7', ...opts });

// ---------------------------------------------------------------------------------------------
// Configuracion de prueba (valores falsos; no son credenciales reales de Google)

const rand32 = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const CLIENT_SECRET = 'test-client-secret-NOT-REAL';
const OAUTH_ENV: Partial<Env> = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  TOKEN_ENC_KEY: rand32(),
  OAUTH_STATE_KEY: rand32(),
};
const fullEnv = (): Env => ({ ...env, ...OAUTH_ENV }) as Env;

const APP_URL = 'https://josedcp20.github.io/organizador/';
const REDIRECT_URI = 'https://organizador-api.jose-dcp20.workers.dev/oauth/google/callback';
const EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const CALLIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const FULL_CALENDAR = 'https://www.googleapis.com/auth/calendar';
const EXACT = `${EVENTS} ${CALLIST}`;

const REFRESH = '1//refresh-token-SECRET-value';
const ACCESS = 'ya29.access-token-SECRET-value';
const CODE = '4/auth-code-SECRET-value';

// ---------------------------------------------------------------------------------------------
// fetch de Google simulado

interface Captured {
  url: string;
  body: URLSearchParams;
}
let calls: Captured[];
let tokenResponse: () => Response | Promise<Response>;
let revokeResponse: () => Response;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const tokenOk = (scope = EXACT, extra: Record<string, unknown> = {}) =>
  json({
    access_token: ACCESS,
    expires_in: 3599,
    refresh_token: REFRESH,
    scope,
    token_type: 'Bearer',
    ...extra,
  });

let logs: string[];

beforeEach(async () => {
  await clearFailures();
  await env.DB.prepare('DELETE FROM google_auth').run();
  await env.DB.prepare('DELETE FROM job_state').run();
  setClock();
  calls = [];
  tokenResponse = () => tokenOk();
  revokeResponse = () => new Response(null, { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: new URLSearchParams(String(init?.body ?? '')) });
      if (url === GOOGLE_TOKEN_URL) return tokenResponse();
      if (url === GOOGLE_REVOKE_URL) return revokeResponse();
      throw new Error(`fetch inesperado a ${url}`);
    }),
  );
  logs = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  setClock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Ningun log debe contener tokens, codes ni el client secret.
  for (const line of logs) {
    for (const secret of [REFRESH, ACCESS, CODE, CLIENT_SECRET, 'SECRET']) {
      expect(line).not.toContain(secret);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Helpers del flujo

const withOAuth = (extra: Partial<Env> = {}) => ({ ...OAUTH_ENV, ...extra });

async function getTicket(extra: Partial<Env> = {}): Promise<string> {
  const res = await call('/api/oauth/google/ticket', { method: 'POST', env: withOAuth(extra) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ticket: string; expiresIn: number };
  expect(body.expiresIn).toBe(60);
  return body.ticket;
}

function start(ticket: string, extra: Partial<Env> = {}) {
  return call(`/oauth/google/start?ticket=${encodeURIComponent(ticket)}`, {
    auth: null,
    env: withOAuth(extra),
  });
}

/** Ejecuta ticket + start y devuelve la URL de consentimiento de Google. */
async function consentUrl(): Promise<URL> {
  const res = await start(await getTicket());
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get('Location')!);
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  return url;
}

function callback(params: Record<string, string>, extra: Partial<Env> = {}) {
  return call(`/oauth/google/callback?${new URLSearchParams(params).toString()}`, {
    auth: null,
    env: withOAuth(extra),
  });
}

/** Comprueba que es una vuelta a APP_URL y devuelve los parametros del hash. */
function appResult(res: Response): URLSearchParams {
  expect(res.status).toBe(302);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  const loc = res.headers.get('Location')!;
  expect(loc.startsWith(`${APP_URL}#/ajustes?`)).toBe(true);
  const params = new URLSearchParams(loc.slice(loc.indexOf('?') + 1));
  const google = params.get('google');
  expect(['ok', 'error']).toContain(google);
  if (google === 'error') {
    expect(GOOGLE_CONNECT_REASONS as readonly string[]).toContain(params.get('reason'));
    expect([...params.keys()].sort()).toEqual(['google', 'reason']);
  } else {
    expect([...params.keys()]).toEqual(['google']);
  }
  for (const s of [REFRESH, ACCESS, CODE, 'state=', 'code=']) expect(loc).not.toContain(s);
  return params;
}

const reasonOf = (res: Response) => appResult(res).get('reason');

async function authRow() {
  return env.DB.prepare('SELECT * FROM google_auth WHERE id = 1').first<Record<string, string>>();
}

async function status() {
  const res = await call('/api/google/status', { env: withOAuth() });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    configured: boolean;
    connected: boolean;
    reason: string | null;
    scopes: string[];
    lastError: string | null;
  };
}

async function connect(scope = EXACT): Promise<URLSearchParams> {
  const state = (await consentUrl()).searchParams.get('state')!;
  tokenResponse = () => tokenOk(scope);
  return appResult(await callback({ state, code: CODE }));
}

const tokenCalls = () => calls.filter((c) => c.url === GOOGLE_TOKEN_URL);
const revokeCalls = () => calls.filter((c) => c.url === GOOGLE_REVOKE_URL);

// ---------------------------------------------------------------------------------------------

describe('GOOGLE_SCOPES', () => {
  it('es exactamente calendar.events + calendarlist.readonly y nunca auth/calendar a secas', () => {
    expect([...GOOGLE_SCOPES].sort()).toEqual([CALLIST, EVENTS].sort());
    expect(GOOGLE_SCOPES).not.toContain(FULL_CALENDAR);
    for (const s of GOOGLE_SCOPES) expect(s).not.toMatch(/\/auth\/calendar$/);
  });

  it('checkScopes compara como conjunto', () => {
    expect(checkScopes(`${CALLIST} ${EVENTS}`).ok).toBe(true);
    expect(checkScopes(`  ${EVENTS}   ${CALLIST} ${EVENTS} `).ok).toBe(true);
    expect(checkScopes(CALLIST)).toMatchObject({ ok: false, missing: [EVENTS], extra: [] });
    expect(checkScopes(`${EXACT} openid`)).toMatchObject({
      ok: false,
      missing: [],
      extra: ['openid'],
    });
    expect(checkScopes(undefined)).toMatchObject({ ok: false, granted: [] });
  });
});

describe('rutas protegidas por Bearer', () => {
  for (const [method, path] of [
    ['POST', '/api/oauth/google/ticket'],
    ['GET', '/api/google/status'],
    ['POST', '/api/google/disconnect'],
    ['DELETE', '/api/oauth/google'],
  ] as const) {
    it(`${method} ${path} sin token -> 401 y sin llamadas a Google`, async () => {
      const res = await call(path, { method, auth: null, env: withOAuth() });
      expect(res.status).toBe(401);
      expect(calls).toHaveLength(0);
    });
  }
});

describe('fail-closed sin configuracion', () => {
  const missing: Array<[string, Partial<Env>]> = [
    ['sin GOOGLE_CLIENT_ID', { GOOGLE_CLIENT_ID: undefined }],
    ['sin GOOGLE_CLIENT_SECRET', { GOOGLE_CLIENT_SECRET: '' }],
    ['sin TOKEN_ENC_KEY', { TOKEN_ENC_KEY: undefined }],
    ['TOKEN_ENC_KEY de 16 bytes', { TOKEN_ENC_KEY: toBase64Url(new Uint8Array(16)) }],
    ['sin OAUTH_STATE_KEY', { OAUTH_STATE_KEY: undefined }],
    ['sin GOOGLE_REDIRECT_URI', { GOOGLE_REDIRECT_URI: undefined }],
    [
      'GOOGLE_REDIRECT_URI http no local',
      { GOOGLE_REDIRECT_URI: 'http://evil.example/oauth/google/callback' },
    ],
    ['GOOGLE_REDIRECT_URI con otra ruta', { GOOGLE_REDIRECT_URI: 'https://x.workers.dev/otra' }],
  ];
  for (const [name, override] of missing) {
    it(`${name}: ticket 500 misconfigured, start/callback -> reason=misconfigured`, async () => {
      const res = await call('/api/oauth/google/ticket', {
        method: 'POST',
        env: withOAuth(override),
      });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('misconfigured');
      expect(reasonOf(await start('v1.x.1.y', override))).toBe('misconfigured');
      expect(reasonOf(await callback({ state: 'x', code: 'y' }, override))).toBe('misconfigured');
      const st = await call('/api/google/status', { env: withOAuth(override) });
      expect(((await st.json()) as { configured: boolean }).configured).toBe(false);
      expect(calls).toHaveLength(0);
    });
  }

  it('el entorno por defecto (sin secretos de Google) no esta configurado', async () => {
    expect(await loadOAuthConfig(env as Env)).toBeNull();
    const res = await call('/api/oauth/google/ticket', { method: 'POST' });
    expect(res.status).toBe(500);
  });

  it('getAccessToken sin configuracion lanza misconfigured sin llamar a Google', async () => {
    await expect(getAccessToken(env as Env)).rejects.toMatchObject({ code: 'misconfigured' });
    expect(calls).toHaveLength(0);
  });

  it('acepta redirect URI local para desarrollo', async () => {
    const cfg = await loadOAuthConfig({
      ...fullEnv(),
      GOOGLE_REDIRECT_URI: 'http://localhost:8787/oauth/google/callback',
    });
    expect(cfg?.redirectUri).toBe('http://localhost:8787/oauth/google/callback');
  });
});

describe('ticket de /start', () => {
  it('es de un solo uso', async () => {
    const ticket = await getTicket();
    expect((await start(ticket)).headers.get('Location')).toMatch(
      /^https:\/\/accounts\.google\.com\//,
    );
    expect(reasonOf(await start(ticket))).toBe('invalid_ticket');
  });

  it('caduca a los 60 s', async () => {
    const t0 = Date.now();
    setClock(() => t0);
    const ticket = await getTicket();
    setClock(() => t0 + 60_001);
    expect(reasonOf(await start(ticket))).toBe('invalid_ticket');
  });

  it('valido justo antes de caducar', async () => {
    const t0 = Date.now();
    setClock(() => t0);
    const ticket = await getTicket();
    setClock(() => t0 + 59_000);
    expect((await start(ticket)).headers.get('Location')).toMatch(
      /^https:\/\/accounts\.google\.com\//,
    );
  });

  it('manipulado, ausente o firmado con otra clave -> invalid_ticket', async () => {
    const ticket = await getTicket();
    const [v, n, e, s] = ticket.split('.');
    expect(reasonOf(await start(`${v}.${n}.${Number(e) + 100000}.${s}`))).toBe('invalid_ticket');
    expect(reasonOf(await start(''))).toBe('invalid_ticket');
    expect(reasonOf(await start(ticket, { OAUTH_STATE_KEY: rand32() }))).toBe('invalid_ticket');
    const noParam = await call('/oauth/google/start', { auth: null, env: withOAuth() });
    expect(reasonOf(noParam)).toBe('invalid_ticket');
    // El original sigue sin usar y funciona.
    expect((await start(ticket)).status).toBe(302);
  });

  it('un ticket no sirve como state (separacion de proposito)', async () => {
    const ticket = await getTicket();
    expect(reasonOf(await callback({ state: ticket, code: CODE }))).toBe('invalid_state');
    expect(tokenCalls()).toHaveLength(0);
  });

  it('no se guarda nada en D1 con tickets falsificados', async () => {
    await start('v1.' + 'a'.repeat(43) + '.99999999999999.' + 'b'.repeat(43));
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM job_state').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('purga tickets/state caducados al emitir uno nuevo', async () => {
    const t0 = Date.now();
    setClock(() => t0);
    await getTicket();
    await getTicket();
    setClock(() => t0 + 11 * 60_000);
    await getTicket();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM job_state').first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe('URL de consentimiento', () => {
  it('contiene exactamente GOOGLE_SCOPES y los parametros requeridos', async () => {
    const url = await consentUrl();
    const p = url.searchParams;
    expect(p.get('scope')!.split(' ').sort()).toEqual([...GOOGLE_SCOPES].sort());
    expect(p.get('scope')!.split(' ')).not.toContain(FULL_CALENDAR);
    expect(url.toString()).not.toMatch(/auth%2Fcalendar(?![.%\w])/);
    expect(url.toString()).not.toMatch(/auth\/calendar(?![.\w])/);
    expect(p.get('client_id')).toBe(OAUTH_ENV.GOOGLE_CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('false');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state')).toMatch(/^v1\./);
    expect(url.toString()).not.toContain(CLIENT_SECRET);
  });

  it('state distinto en cada inicio', async () => {
    const a = (await consentUrl()).searchParams.get('state');
    const b = (await consentUrl()).searchParams.get('state');
    expect(a).not.toBe(b);
  });
});

describe('callback', () => {
  it('flujo correcto: guarda refresh token cifrado y vuelve con google=ok', async () => {
    const url = await consentUrl();
    const res = await callback({ state: url.searchParams.get('state')!, code: CODE, scope: EXACT });
    expect(appResult(res).get('google')).toBe('ok');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

    const [tc] = tokenCalls();
    expect(tc!.body.get('grant_type')).toBe('authorization_code');
    expect(tc!.body.get('code')).toBe(CODE);
    expect(tc!.body.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(tc!.body.get('client_secret')).toBe(CLIENT_SECRET);
    expect(tc!.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = (await authRow())!;
    expect(row.refresh_token_enc).toMatch(/^v1\./);
    expect(row.refresh_token_enc).not.toContain(REFRESH);
    expect(row.access_token).toMatch(/^v1\./);
    expect(row.access_token).not.toContain(ACCESS);
    expect(row.scope!.split(' ').sort()).toEqual([...GOOGLE_SCOPES].sort());
    expect(row.last_error).toBeNull();

    const st = await status();
    expect(st).toMatchObject({ configured: true, connected: true, reason: null, lastError: null });
    expect(st.scopes.sort()).toEqual([...GOOGLE_SCOPES].sort());
    expect(revokeCalls()).toHaveLength(0);
  });

  it('el code_verifier enviado corresponde al code_challenge (PKCE S256)', async () => {
    const url = await consentUrl();
    await callback({ state: url.searchParams.get('state')!, code: CODE });
    const verifier = tokenCalls()[0]!.body.get('code_verifier')!;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    expect(toBase64Url(new Uint8Array(digest))).toBe(url.searchParams.get('code_challenge'));
  });

  it('state invalido -> invalid_state sin llamar a Google', async () => {
    await consentUrl();
    for (const state of [
      '',
      'basura',
      'v1.' + 'a'.repeat(43) + '.99999999999999.' + 'b'.repeat(43),
    ]) {
      expect(reasonOf(await callback({ state, code: CODE }))).toBe('invalid_state');
    }
    expect(reasonOf(await callback({ code: CODE }))).toBe('invalid_state');
    expect(tokenCalls()).toHaveLength(0);
    expect(await authRow()).toBeNull();
  });

  it('state con firma manipulada -> invalid_state', async () => {
    const state = (await consentUrl()).searchParams.get('state')!;
    const [v, n, e] = state.split('.');
    const forged = `${v}.${n}.${e}.${'A'.repeat(43)}`;
    expect(reasonOf(await callback({ state: forged, code: CODE }))).toBe('invalid_state');
    expect(tokenCalls()).toHaveLength(0);
  });

  it('state caducado (> 10 min) -> invalid_state', async () => {
    const t0 = Date.now();
    setClock(() => t0);
    const state = (await consentUrl()).searchParams.get('state')!;
    setClock(() => t0 + 10 * 60_000 + 1);
    expect(reasonOf(await callback({ state, code: CODE }))).toBe('invalid_state');
    expect(tokenCalls()).toHaveLength(0);
  });

  it('state reutilizado -> invalid_state la segunda vez (un solo uso)', async () => {
    const state = (await consentUrl()).searchParams.get('state')!;
    expect(appResult(await callback({ state, code: CODE })).get('google')).toBe('ok');
    expect(reasonOf(await callback({ state, code: CODE }))).toBe('invalid_state');
    expect(tokenCalls()).toHaveLength(1);
  });

  it('state consumido aunque el usuario cancele (access_denied)', async () => {
    const state = (await consentUrl()).searchParams.get('state')!;
    expect(reasonOf(await callback({ state, error: 'access_denied' }))).toBe('access_denied');
    expect(reasonOf(await callback({ state, code: CODE }))).toBe('invalid_state');
    expect(tokenCalls()).toHaveLength(0);
  });

  it('con `calendar` completo -> revoca y rechaza', async () => {
    expect((await connect(FULL_CALENDAR)).get('reason')).toBe('extra_scope');
    expect(revokeCalls()).toHaveLength(1);
    expect(revokeCalls()[0]!.body.get('token')).toBe(REFRESH);
    expect(await authRow()).toBeNull();
  });

  it('con `calendar` completo ademas de los correctos -> revoca y rechaza', async () => {
    expect((await connect(`${EXACT} ${FULL_CALENDAR}`)).get('reason')).toBe('extra_scope');
    expect(revokeCalls()).toHaveLength(1);
    expect(await authRow()).toBeNull();
  });

  for (const extra of [
    'https://www.googleapis.com/auth/calendar.settings.readonly',
    'https://www.googleapis.com/auth/calendar.acls',
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
  ]) {
    it(`con scope extra ${extra} -> revoca y rechaza`, async () => {
      expect((await connect(`${EXACT} ${extra}`)).get('reason')).toBe('extra_scope');
      expect(revokeCalls()).toHaveLength(1);
      expect(await authRow()).toBeNull();
    });
  }

  it('sin calendar.events -> rechazo (missing_scope), sin guardar', async () => {
    expect((await connect(CALLIST)).get('reason')).toBe('missing_scope');
    expect(revokeCalls()).toHaveLength(0);
    expect(await authRow()).toBeNull();
  });

  it('sin scope en la respuesta -> rechazo y revocacion (fail-closed)', async () => {
    const state = (await consentUrl()).searchParams.get('state')!;
    tokenResponse = () => json({ access_token: ACCESS, expires_in: 3600, refresh_token: REFRESH });
    expect(reasonOf(await callback({ state, code: CODE }))).toBe('missing_scope');
    expect(revokeCalls()).toHaveLength(1);
    expect(await authRow()).toBeNull();
  });

  it('un rechazo no borra una conexion previa valida', async () => {
    await connect();
    expect((await connect(CALLIST)).get('reason')).toBe('missing_scope');
    expect((await status()).connected).toBe(true);
  });

  it('Google rechaza el code -> exchange_failed', async () => {
    const state = (await consentUrl()).searchParams.get('state')!;
    tokenResponse = () => json({ error: 'invalid_grant', error_description: 'Bad code' }, 400);
    expect(reasonOf(await callback({ state, code: CODE }))).toBe('exchange_failed');
    expect(await authRow()).toBeNull();
  });

  it('respuesta de token invalida o error de red -> exchange_failed', async () => {
    let state = (await consentUrl()).searchParams.get('state')!;
    tokenResponse = () => json({ hola: 1 });
    expect(reasonOf(await callback({ state, code: CODE }))).toBe('exchange_failed');
    state = (await consentUrl()).searchParams.get('state')!;
    tokenResponse = () => {
      throw new TypeError('network down');
    };
    expect(reasonOf(await callback({ state, code: CODE }))).toBe('exchange_failed');
  });

  it('sin refresh_token -> no_refresh_token', async () => {
    const state = (await consentUrl()).searchParams.get('state')!;
    tokenResponse = () => json({ access_token: ACCESS, expires_in: 3600, scope: EXACT });
    expect(reasonOf(await callback({ state, code: CODE }))).toBe('no_refresh_token');
    expect(await authRow()).toBeNull();
  });

  it('sin code o con error distinto -> invalid_request', async () => {
    let state = (await consentUrl()).searchParams.get('state')!;
    expect(reasonOf(await callback({ state }))).toBe('invalid_request');
    state = (await consentUrl()).searchParams.get('state')!;
    expect(reasonOf(await callback({ state, error: 'server_error' }))).toBe('invalid_request');
  });

  it('solo redirige a APP_URL: ignora destinos en la query', async () => {
    const state = (await consentUrl()).searchParams.get('state')!;
    const res = await callback({
      state,
      code: CODE,
      redirect_uri: 'https://evil.example/',
      next: 'https://evil.example/',
      return_to: '//evil.example',
    });
    expect(res.headers.get('Location')!.startsWith(APP_URL)).toBe(true);
    expect(res.headers.get('Location')).not.toContain('evil');
  });

  it('error interno (D1 rota) -> reason=internal, sin detalles', async () => {
    const state = (await consentUrl()).searchParams.get('state')!;
    const brokenDb = {
      prepare: () => {
        throw new Error('D1 SECRET detail');
      },
    } as unknown as D1Database;
    const res = await callback({ state, code: CODE }, { DB: brokenDb });
    expect(reasonOf(res)).toBe('internal');
  });
});

describe('access token: cache, refresh y revalidacion de scope', () => {
  async function seed(expiresInSec: number) {
    const cfg = (await loadOAuthConfig(fullEnv()))!;
    await saveConnection(
      env.DB,
      cfg,
      { access_token: 'ya29.old-SECRET', expires_in: expiresInSec, refresh_token: REFRESH },
      [...GOOGLE_SCOPES],
    );
  }

  const refreshOk = (scope = EXACT, access = 'ya29.new-SECRET') =>
    json({ access_token: access, expires_in: 3599, scope, token_type: 'Bearer' });

  it('usa el access token cacheado si no ha caducado (sin fetch)', async () => {
    await seed(3600);
    expect(await getAccessToken(fullEnv())).toBe('ya29.old-SECRET');
    expect(calls).toHaveLength(0);
  });

  it('caducado (o dentro del margen) -> refresh con fetch mock y cachea el nuevo', async () => {
    const t0 = Date.now();
    setClock(() => t0);
    await seed(3600);
    tokenResponse = () => refreshOk();
    // A falta de menos del margen para caducar, se renueva.
    const t1 = t0 + 3600_000 - ACCESS_TOKEN_MARGIN_MS + 1000;
    expect(await getAccessToken(fullEnv(), t1)).toBe('ya29.new-SECRET');
    const [tc] = tokenCalls();
    expect(tc!.body.get('grant_type')).toBe('refresh_token');
    expect(tc!.body.get('refresh_token')).toBe(REFRESH);
    expect(tc!.body.get('client_id')).toBe(OAUTH_ENV.GOOGLE_CLIENT_ID);
    // Segunda llamada: sale de la cache (cifrada en D1).
    expect(await getAccessToken(fullEnv(), t1 + 1000)).toBe('ya29.new-SECRET');
    expect(tokenCalls()).toHaveLength(1);
    const row = (await authRow())!;
    expect(row.access_token).not.toContain('ya29.new');
    expect(Date.parse(row.access_token_expires_at!)).toBe(t1 + 3599_000);
  });

  it('tras borrar el access token se renueva solo', async () => {
    await seed(3600);
    await env.DB.prepare('UPDATE google_auth SET access_token = NULL').run();
    tokenResponse = () => refreshOk();
    expect(await getAccessToken(fullEnv())).toBe('ya29.new-SECRET');
    expect(tokenCalls()).toHaveLength(1);
  });

  it('access token cacheado ilegible -> se renueva', async () => {
    await seed(3600);
    await env.DB.prepare("UPDATE google_auth SET access_token = 'v1.AAAA.BBBB'").run();
    tokenResponse = () => refreshOk();
    expect(await getAccessToken(fullEnv())).toBe('ya29.new-SECRET');
  });

  it('guarda el refresh token rotado si Google devuelve uno nuevo', async () => {
    await seed(0);
    tokenResponse = () =>
      json({
        access_token: 'ya29.a-SECRET',
        expires_in: 3599,
        scope: EXACT,
        refresh_token: '1//rot-SECRET',
      });
    await getAccessToken(fullEnv(), Date.now() + 120_000);
    await env.DB.prepare('UPDATE google_auth SET access_token = NULL').run();
    tokenResponse = () => refreshOk();
    await getAccessToken(fullEnv());
    expect(tokenCalls()[1]!.body.get('refresh_token')).toBe('1//rot-SECRET');
  });

  it('invalid_grant marca desconectado (estado visible) y no reintenta', async () => {
    await seed(0);
    tokenResponse = () =>
      json(
        { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        400,
      );
    await expect(getAccessToken(fullEnv(), Date.now() + 120_000)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    const st = await status();
    expect(st).toMatchObject({
      connected: false,
      reason: 'invalid_grant',
      lastError: 'invalid_grant',
      scopes: [],
    });
    const row = (await authRow())!;
    expect(row.refresh_token_enc).toBe('');
    expect(row.access_token).toBeNull();
    await expect(getAccessToken(fullEnv())).rejects.toBeInstanceOf(GoogleAuthError);
    expect(tokenCalls()).toHaveLength(1);
  });

  it('refresh con scope extra -> revoca y marca desconectado (scope_mismatch)', async () => {
    await seed(0);
    tokenResponse = () => refreshOk(`${EXACT} ${FULL_CALENDAR}`);
    await expect(getAccessToken(fullEnv(), Date.now() + 120_000)).rejects.toMatchObject({
      code: 'scope_mismatch',
    });
    expect(revokeCalls()).toHaveLength(1);
    expect(revokeCalls()[0]!.body.get('token')).toBe(REFRESH);
    expect(await status()).toMatchObject({ connected: false, reason: 'scope_mismatch' });
  });

  it('refresh sin calendar.events -> desconectado (scope_mismatch) sin revocar', async () => {
    await seed(0);
    tokenResponse = () => refreshOk(CALLIST);
    await expect(getAccessToken(fullEnv(), Date.now() + 120_000)).rejects.toMatchObject({
      code: 'scope_mismatch',
    });
    expect(revokeCalls()).toHaveLength(0);
    expect((await status()).reason).toBe('scope_mismatch');
  });

  it('fallo transitorio (500 / red) -> unavailable, sigue conectado con lastError', async () => {
    await seed(0);
    tokenResponse = () => json({ error: 'backend_error' }, 500);
    await expect(getAccessToken(fullEnv(), Date.now() + 120_000)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(await status()).toMatchObject({ connected: true, lastError: 'refresh_failed' });
    tokenResponse = () => refreshOk();
    expect(await getAccessToken(fullEnv(), Date.now() + 120_000)).toBe('ya29.new-SECRET');
    expect((await status()).lastError).toBeNull();
  });

  it('sin conexion -> not_connected sin fetch', async () => {
    await expect(getAccessToken(fullEnv())).rejects.toMatchObject({ code: 'not_connected' });
    expect(calls).toHaveLength(0);
  });

  it('TOKEN_ENC_KEY cambiada -> no se puede descifrar: misconfigured sin fetch', async () => {
    await seed(0);
    await expect(
      getAccessToken({ ...fullEnv(), TOKEN_ENC_KEY: rand32() }, Date.now() + 120_000),
    ).rejects.toMatchObject({ code: 'misconfigured' });
    expect(calls).toHaveLength(0);
    // Queda registrado y visible: requiere reconexion (sin invalid_grant ni revocar).
    expect(await status()).toMatchObject({
      connected: false,
      reason: 'unreadable',
      lastError: 'unreadable',
      scopes: [],
    });
    expect((await authRow())!.refresh_token_enc).not.toBe('');
    expect(revokeCalls()).toHaveLength(0);
  });

  it('fila ilegible: si la clave vuelve a ser la correcta, se recupera sola', async () => {
    await seed(0);
    await expect(
      getAccessToken({ ...fullEnv(), TOKEN_ENC_KEY: rand32() }, Date.now() + 120_000),
    ).rejects.toMatchObject({ code: 'misconfigured' });
    tokenResponse = () => refreshOk();
    expect(await getAccessToken(fullEnv(), Date.now() + 120_000)).toBe('ya29.new-SECRET');
    expect(await status()).toMatchObject({ connected: true, reason: null, lastError: null });
  });
});

describe('status y disconnect', () => {
  it('status sin conexion', async () => {
    expect(await status()).toEqual({
      configured: true,
      connected: false,
      reason: 'not_connected',
      scopes: [],
      connectedAt: null,
      lastError: null,
    });
  });

  it('disconnect revoca en Google y borra credenciales', async () => {
    await connect();
    const res = await call('/api/google/disconnect', { method: 'POST', env: withOAuth() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(revokeCalls()).toHaveLength(1);
    expect(revokeCalls()[0]!.body.get('token')).toBe(REFRESH);
    expect(await authRow()).toBeNull();
    expect((await status()).reason).toBe('not_connected');
  });

  it('si la revocacion falla, borra igualmente y lo indica', async () => {
    await connect();
    revokeResponse = () => json({ error: 'invalid_token' }, 400);
    const res = await call('/api/oauth/google', { method: 'DELETE', env: withOAuth() });
    expect(await res.json()).toEqual({ ok: true, revoked: false });
    expect(await authRow()).toBeNull();
  });

  it('disconnect sin conexion ni configuracion: ok, sin llamadas', async () => {
    const res = await call('/api/google/disconnect', { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true, revoked: false });
    expect(calls).toHaveLength(0);
  });

  it('la respuesta de status no contiene tokens cifrados ni en claro', async () => {
    await connect();
    const res = await call('/api/google/status', { env: withOAuth() });
    const text = await res.text();
    expect(text).not.toContain('v1.');
    expect(text).not.toContain(REFRESH);
    expect(text).not.toContain(ACCESS);
  });
});

describe('revocacion en el callback con conexion previa', () => {
  it('extra_scope con conexion previa -> la conexion queda desconectada', async () => {
    await connect();
    expect((await status()).connected).toBe(true);
    expect((await connect(`${EXACT} ${FULL_CALENDAR}`)).get('reason')).toBe('extra_scope');
    expect(revokeCalls()).toHaveLength(1);
    expect(await status()).toMatchObject({
      connected: false,
      reason: 'scope_mismatch',
      lastError: 'scope_mismatch',
      scopes: [],
    });
    const row = (await authRow())!;
    expect(row.refresh_token_enc).toBe('');
    expect(row.access_token).toBeNull();
    await expect(getAccessToken(fullEnv())).rejects.toMatchObject({ code: 'scope_mismatch' });
  });

  it('sin scope en la respuesta (revoca) con conexion previa -> tambien desconectada', async () => {
    await connect();
    const state = (await consentUrl()).searchParams.get('state')!;
    tokenResponse = () => json({ access_token: ACCESS, expires_in: 3600, refresh_token: REFRESH });
    expect(reasonOf(await callback({ state, code: CODE }))).toBe('missing_scope');
    expect(revokeCalls()).toHaveLength(1);
    expect(await status()).toMatchObject({ connected: false, reason: 'scope_mismatch' });
  });

  it('missing_scope (sin revocar) no toca la conexion previa', async () => {
    await connect();
    expect((await connect(CALLIST)).get('reason')).toBe('missing_scope');
    expect(revokeCalls()).toHaveLength(0);
    expect(await status()).toMatchObject({ connected: true, lastError: null });
    expect((await authRow())!.refresh_token_enc).not.toBe('');
  });
});

describe('concurrencia', () => {
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    return { promise, release };
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };
  async function seed(expiresInSec = 0) {
    const cfg = (await loadOAuthConfig(fullEnv()))!;
    await saveConnection(
      env.DB,
      cfg,
      { access_token: 'ya29.old-SECRET', expires_in: expiresInSec, refresh_token: REFRESH },
      [...GOOGLE_SCOPES],
    );
  }
  const later = () => Date.now() + 120_000;

  it('doble canje simultaneo del mismo ticket -> exactamente un exito', async () => {
    const ticket = await getTicket();
    const results = await Promise.all([start(ticket), start(ticket)]);
    const ok = results.filter((r) =>
      (r.headers.get('Location') ?? '').startsWith('https://accounts.google.com/'),
    );
    expect(ok).toHaveLength(1);
    const other = results.find((r) => !ok.includes(r))!;
    expect(reasonOf(other)).toBe('invalid_ticket');
  });

  it('doble canje simultaneo del mismo state -> exactamente un exito', async () => {
    const state = (await consentUrl()).searchParams.get('state')!;
    tokenResponse = () => tokenOk();
    const results = await Promise.all([
      callback({ state, code: CODE }),
      callback({ state, code: CODE }),
    ]);
    const params = results.map(appResult);
    expect(params.filter((p) => p.get('google') === 'ok')).toHaveLength(1);
    expect(params.filter((p) => p.get('reason') === 'invalid_state')).toHaveLength(1);
    expect(tokenCalls()).toHaveLength(1);
  });

  it('un invalid_grant tardio no pisa una reconexion ya guardada', async () => {
    await seed();
    const g = gate();
    tokenResponse = async () => {
      await g.promise;
      return json({ error: 'invalid_grant' }, 400);
    };
    const pending = getAccessToken(fullEnv(), later());
    const assertion = expect(pending).rejects.toMatchObject({ code: 'invalid_grant' });
    await until(() => tokenCalls().length === 1);
    // Mientras tanto el usuario reconecta con un refresh token nuevo.
    const cfg = (await loadOAuthConfig(fullEnv()))!;
    await saveConnection(
      env.DB,
      cfg,
      { access_token: ACCESS, expires_in: 3600, refresh_token: '1//reconnected-SECRET' },
      [...GOOGLE_SCOPES],
    );
    g.release();
    await assertion;
    expect(await status()).toMatchObject({ connected: true, reason: null, lastError: null });
    expect((await authRow())!.refresh_token_enc).not.toBe('');
  });

  it('un invalid_grant tardio no pisa un refresh ya guardado (token rotado)', async () => {
    await seed();
    const g = gate();
    let n = 0;
    tokenResponse = async () => {
      if (n++ === 0) {
        await g.promise;
        return json({ error: 'invalid_grant' }, 400);
      }
      return json({
        access_token: 'ya29.new-SECRET',
        refresh_token: '1//rot-SECRET',
        expires_in: 3599,
        scope: EXACT,
      });
    };
    const slow = getAccessToken(fullEnv(), later());
    const assertion = expect(slow).rejects.toMatchObject({ code: 'invalid_grant' });
    await until(() => tokenCalls().length === 1);
    expect(await getAccessToken(fullEnv(), later())).toBe('ya29.new-SECRET');
    g.release();
    await assertion;
    expect(await status()).toMatchObject({ connected: true, reason: null });
    expect((await authRow())!.refresh_token_enc).not.toBe('');
  });

  it('un refresh en curso durante una desconexion no resucita la fila', async () => {
    await seed();
    const g = gate();
    tokenResponse = async () => {
      await g.promise;
      return json({ access_token: 'ya29.new-SECRET', expires_in: 3599, scope: EXACT });
    };
    const refresh = getAccessToken(fullEnv(), later());
    await until(() => tokenCalls().length === 1);
    const res = await call('/api/google/disconnect', { method: 'POST', env: withOAuth() });
    expect(res.status).toBe(200);
    g.release();
    await refresh;
    expect(await authRow()).toBeNull();
    expect(await status()).toMatchObject({ connected: false, reason: 'not_connected' });
  });

  it('/oauth/google/start: la redireccion 302 lleva no-store y no-referrer', async () => {
    const res = await start(await getTicket());
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});
