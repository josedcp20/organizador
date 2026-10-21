import type { GoogleDisconnectReason, GoogleStatus } from '@organizador/shared';
import { now } from '../clock';
import { randomBytes, toBase64Url } from '../crypto/encoding';
import { importEncKey, open, seal } from '../crypto/secretBox';
import { importStateKey } from '../crypto/signedToken';
import type { Env } from '../env';

/**
 * UNICO modulo que habla con los endpoints OAuth de Google (consentimiento, token, revoke).
 * Nunca registra en logs tokens, codes ni el client secret: solo codigos cortos y status HTTP.
 */

/**
 * Conjunto EXACTO de scopes que se piden y se aceptan (D10 + D11). Nunca `.../auth/calendar`
 * a secas. Si D11 se cierra sin necesitar calendarList.readonly, se quita de aqui (y de M6).
 */
export const GOOGLE_SCOPES: readonly string[] = Object.freeze([
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
]);

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const CALLBACK_PATH = '/oauth/google/callback';

/** Margen con el que un access token cacheado se considera caducado y se renueva. */
export const ACCESS_TOKEN_MARGIN_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

// AAD de secretBox: cada secreto solo se descifra en su contexto.
const AAD_REFRESH = 'organizador/google_auth/refresh_token/v1';
const AAD_ACCESS = 'organizador/google_auth/access_token/v1';

export class GoogleAuthError extends Error {
  readonly code:
    'misconfigured' | 'not_connected' | 'invalid_grant' | 'scope_mismatch' | 'unavailable';
  constructor(code: GoogleAuthError['code']) {
    super(code);
    this.name = 'GoogleAuthError';
    this.code = code;
  }
}

function log(code: string, status?: number): void {
  // Solo codigos y status: jamas cuerpos de respuesta, tokens, codes ni secretos.
  console.warn('google_oauth', code, status ?? '');
}

// ---------------------------------------------------------------------------------------------
// Configuracion (fail-closed)

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateKey: CryptoKey;
  encKey: CryptoKey;
}

function isLocalHttp(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/** GOOGLE_REDIRECT_URI valida: https (o http://localhost), ruta exacta del callback, sin query. */
export function validRedirectUri(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !isLocalHttp(url)) return null;
  if (url.pathname !== CALLBACK_PATH || url.search || url.hash || url.username) return null;
  return url.toString();
}

/**
 * Carga y valida la configuracion OAuth. null si falta o es invalido cualquier elemento
 * (client id/secret, redirect URI, OAUTH_STATE_KEY, TOKEN_ENC_KEY): todo el flujo falla cerrado.
 */
export async function loadOAuthConfig(env: Env): Promise<OAuthConfig | null> {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = validRedirectUri(env.GOOGLE_REDIRECT_URI);
  if (!clientId || !clientSecret || !redirectUri) return null;
  const [stateKey, encKey] = await Promise.all([
    importStateKey(env.OAUTH_STATE_KEY),
    importEncKey(env.TOKEN_ENC_KEY),
  ]);
  if (!stateKey || !encKey) return null;
  return { clientId, clientSecret, redirectUri, stateKey, encKey };
}

// ---------------------------------------------------------------------------------------------
// Scopes

export type ScopeCheck =
  | { ok: true; scopes: string[] }
  | { ok: false; granted: string[]; missing: string[]; extra: string[] };

export function parseScopes(scope: unknown): string[] {
  if (typeof scope !== 'string') return [];
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort();
}

/** Compara el conjunto concedido con GOOGLE_SCOPES (como conjuntos, sin orden). */
export function checkScopes(scope: unknown): ScopeCheck {
  const granted = parseScopes(scope);
  const required = new Set(GOOGLE_SCOPES);
  const missing = GOOGLE_SCOPES.filter((s) => !granted.includes(s));
  const extra = granted.filter((s) => !required.has(s));
  if (missing.length === 0 && extra.length === 0) return { ok: true, scopes: granted };
  return { ok: false, granted, missing, extra };
}

// ---------------------------------------------------------------------------------------------
// PKCE + URL de consentimiento

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = toBase64Url(randomBytes(32));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

export function buildConsentUrl(cfg: OAuthConfig, state: string, codeChallenge: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'false');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ---------------------------------------------------------------------------------------------
// Llamadas HTTP a Google

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

type PostResult =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'error'; status: number; error: string }
  | { kind: 'network' };

async function postForm(url: string, params: Record<string, string>): Promise<PostResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'network' };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (!res.ok) {
    return {
      kind: 'error',
      status: res.status,
      error: typeof obj.error === 'string' ? obj.error : '',
    };
  }
  return { kind: 'ok', body: obj };
}

function parseTokenBody(body: Record<string, unknown>): TokenResponse | null {
  const { access_token, expires_in, refresh_token, scope } = body;
  if (typeof access_token !== 'string' || !access_token) return null;
  if (typeof expires_in !== 'number' || !Number.isFinite(expires_in) || expires_in <= 0)
    return null;
  return {
    access_token,
    expires_in,
    refresh_token: typeof refresh_token === 'string' && refresh_token ? refresh_token : undefined,
    scope: typeof scope === 'string' ? scope : undefined,
  };
}

/** Intercambia el code del callback. null si Google lo rechaza o la respuesta no es valida. */
export async function exchangeCode(
  cfg: OAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse | null> {
  const r = await postForm(GOOGLE_TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    code_verifier: codeVerifier,
  });
  if (r.kind !== 'ok') {
    log('exchange_failed', r.kind === 'error' ? r.status : 0);
    return null;
  }
  const tokens = parseTokenBody(r.body);
  if (!tokens) log('exchange_bad_response');
  return tokens;
}

/** Revoca un token (refresh o access) en Google. Nunca lanza; true si Google respondio 2xx. */
export async function revokeToken(token: string): Promise<boolean> {
  const r = await postForm(GOOGLE_REVOKE_URL, { token });
  if (r.kind !== 'ok') log('revoke_failed', r.kind === 'error' ? r.status : 0);
  return r.kind === 'ok';
}

// ---------------------------------------------------------------------------------------------
// Credenciales en D1 (tabla google_auth, fila id = 1)
//
// Desconectado = sin fila, o fila con refresh_token_enc = '' (credencial invalidada por Google:
// last_error = 'invalid_grant' | 'scope_mismatch'). Se conserva la fila para mostrar el motivo.
// El access token cacheado tambien se guarda cifrado (columna access_token).

interface AuthRow {
  refresh_token_enc: string;
  access_token: string | null;
  access_token_expires_at: string | null;
  scope: string | null;
  connected_at: string;
  last_error: string | null;
}

async function readRow(db: D1Database): Promise<AuthRow | null> {
  return db
    .prepare(
      `SELECT refresh_token_enc, access_token, access_token_expires_at, scope, connected_at, last_error
       FROM google_auth WHERE id = 1`,
    )
    .first<AuthRow>();
}

function expiresAt(nowMs: number, expiresIn: number): string {
  // Acota expires_in por si Google (o un mock) devuelve valores absurdos.
  const secs = Math.min(Math.max(Math.floor(expiresIn), 60), 24 * 3600);
  return new Date(nowMs + secs * 1000).toISOString();
}

/** Guarda una conexion nueva (o la sustituye). El refresh token se cifra con TOKEN_ENC_KEY. */
export async function saveConnection(
  db: D1Database,
  cfg: OAuthConfig,
  tokens: TokenResponse & { refresh_token: string },
  scopes: string[],
  nowMs: number = now(),
): Promise<void> {
  const [refreshEnc, accessEnc] = await Promise.all([
    seal(cfg.encKey, tokens.refresh_token, AAD_REFRESH),
    seal(cfg.encKey, tokens.access_token, AAD_ACCESS),
  ]);
  await db
    .prepare(
      `INSERT INTO google_auth
         (id, refresh_token_enc, access_token, access_token_expires_at, scope, connected_at, last_error)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, NULL)
       ON CONFLICT(id) DO UPDATE SET
         refresh_token_enc = excluded.refresh_token_enc,
         access_token = excluded.access_token,
         access_token_expires_at = excluded.access_token_expires_at,
         scope = excluded.scope,
         connected_at = excluded.connected_at,
         last_error = NULL`,
    )
    .bind(
      refreshEnc,
      accessEnc,
      expiresAt(nowMs, tokens.expires_in),
      scopes.join(' '),
      new Date(nowMs).toISOString(),
    )
    .run();
}

/** Marca desconectado sin perder el motivo. Solo si la credencial sigue siendo la que fallo. */
async function markDisconnected(
  db: D1Database,
  reason: 'invalid_grant' | 'scope_mismatch',
  oldEnc: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE google_auth
       SET refresh_token_enc = '', access_token = NULL, access_token_expires_at = NULL, last_error = ?1
       WHERE id = 1 AND refresh_token_enc = ?2`,
    )
    .bind(reason, oldEnc)
    .run();
}

async function setLastError(db: D1Database, code: string, oldEnc: string): Promise<void> {
  await db
    .prepare('UPDATE google_auth SET last_error = ?1 WHERE id = 1 AND refresh_token_enc = ?2')
    .bind(code, oldEnc)
    .run();
}

/**
 * Tras revocar en el callback (scope extra): Google invalida TODA la concesion de la app, asi que
 * una conexion previa tambien esta muerta. Si hay fila, queda desconectada (sin tokens).
 */
export async function markConnectionRevoked(
  db: D1Database,
  reason: 'scope_mismatch' = 'scope_mismatch',
): Promise<void> {
  await db
    .prepare(
      `UPDATE google_auth
       SET refresh_token_enc = '', access_token = NULL, access_token_expires_at = NULL, last_error = ?1
       WHERE id = 1`,
    )
    .bind(reason)
    .run();
}

type HardReason = 'not_connected' | 'invalid_grant' | 'scope_mismatch';

function disconnectReason(row: AuthRow | null): HardReason | null {
  if (!row) return 'not_connected';
  if (row.refresh_token_enc !== '') return null;
  return row.last_error === 'scope_mismatch' ? 'scope_mismatch' : 'invalid_grant';
}

/**
 * Access token valido para llamar a Calendar API. Usa el cacheado (cifrado en D1) si le quedan
 * mas de ACCESS_TOKEN_MARGIN_MS; si no, lo renueva con el refresh token y revalida el scope.
 * - `invalid_grant` -> marca desconectado (estado visible) y lanza GoogleAuthError('invalid_grant').
 * - scope distinto de GOOGLE_SCOPES -> revoca si sobra algo, marca desconectado, lanza 'scope_mismatch'.
 * - red/5xx/otro 4xx -> last_error = 'refresh_failed' (sigue conectado), lanza 'unavailable'.
 */
export async function getAccessToken(env: Env, nowMs: number = now()): Promise<string> {
  const cfg = await loadOAuthConfig(env);
  if (!cfg) throw new GoogleAuthError('misconfigured');
  const db = env.DB;
  const row = await readRow(db);
  const reason = disconnectReason(row);
  if (reason || !row) throw new GoogleAuthError(reason ?? 'not_connected');

  if (row.access_token && row.access_token_expires_at) {
    const exp = Date.parse(row.access_token_expires_at);
    if (Number.isFinite(exp) && exp - ACCESS_TOKEN_MARGIN_MS > nowMs) {
      try {
        return await open(cfg.encKey, row.access_token, AAD_ACCESS);
      } catch {
        log('access_token_unreadable'); // se renueva abajo
      }
    }
  }

  let refreshToken: string;
  try {
    refreshToken = await open(cfg.encKey, row.refresh_token_enc, AAD_REFRESH);
  } catch {
    // Clave TOKEN_ENC_KEY cambiada o fila manipulada: no se puede usar, hay que reconectar.
    log('refresh_token_unreadable');
    await setLastError(db, 'unreadable', row.refresh_token_enc);
    throw new GoogleAuthError('misconfigured');
  }

  const r = await postForm(GOOGLE_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  if (r.kind === 'error' && r.error === 'invalid_grant') {
    log('invalid_grant', r.status);
    await markDisconnected(db, 'invalid_grant', row.refresh_token_enc);
    throw new GoogleAuthError('invalid_grant');
  }
  const tokens = r.kind === 'ok' ? parseTokenBody(r.body) : null;
  if (!tokens) {
    log('refresh_failed', r.kind === 'error' ? r.status : 0);
    await setLastError(db, 'refresh_failed', row.refresh_token_enc);
    throw new GoogleAuthError('unavailable');
  }

  // Revalidacion del scope en cada refresh (fail-closed: sin `scope` tambien se rechaza).
  const check = checkScopes(tokens.scope);
  if (!check.ok) {
    log('scope_mismatch_on_refresh');
    if (check.extra.length > 0 || check.granted.length === 0) await revokeToken(refreshToken);
    await markDisconnected(db, 'scope_mismatch', row.refresh_token_enc);
    throw new GoogleAuthError('scope_mismatch');
  }

  const accessEnc = await seal(cfg.encKey, tokens.access_token, AAD_ACCESS);
  const newRefreshEnc = tokens.refresh_token
    ? await seal(cfg.encKey, tokens.refresh_token, AAD_REFRESH)
    : row.refresh_token_enc;
  await db
    .prepare(
      `UPDATE google_auth
       SET access_token = ?1, access_token_expires_at = ?2, scope = ?3, last_error = NULL,
           refresh_token_enc = ?4
       WHERE id = 1 AND refresh_token_enc = ?5`,
    )
    .bind(
      accessEnc,
      expiresAt(nowMs, tokens.expires_in),
      check.scopes.join(' '),
      newRefreshEnc,
      row.refresh_token_enc,
    )
    .run();
  return tokens.access_token;
}

/** Estado para `GET /api/google/status` (y, mas adelante, banner y /api/me). */
export async function getGoogleStatus(env: Env): Promise<GoogleStatus> {
  const [cfg, row] = await Promise.all([loadOAuthConfig(env), readRow(env.DB)]);
  let reason: GoogleDisconnectReason | null = disconnectReason(row);
  // Credenciales ilegibles: la fila sigue, pero no se puede usar hasta reconectar.
  if (reason === null && row?.last_error === 'unreadable') reason = 'unreadable';
  return {
    configured: cfg !== null,
    connected: reason === null,
    reason,
    scopes: reason === null && row ? parseScopes(row.scope) : [],
    connectedAt: row?.connected_at ?? null,
    lastError: row?.last_error ?? null,
  };
}

/**
 * Desconecta: revoca en Google (best effort) y borra las credenciales de D1 siempre.
 * `revoked` = Google confirmo la revocacion (si es false, el usuario puede quitar el acceso a
 * mano en myaccount.google.com/permissions).
 */
export async function disconnectGoogle(env: Env): Promise<{ revoked: boolean }> {
  const db = env.DB;
  const row = await readRow(db);
  let revoked = false;
  if (row && row.refresh_token_enc !== '') {
    const key = await importEncKey(env.TOKEN_ENC_KEY);
    if (key) {
      try {
        revoked = await revokeToken(await open(key, row.refresh_token_enc, AAD_REFRESH));
      } catch {
        log('refresh_token_unreadable');
      }
    }
  }
  await db.prepare('DELETE FROM google_auth WHERE id = 1').run();
  return { revoked };
}

/** Solo para tests: lectura cruda de la fila (para comprobar que esta cifrada). */
export const __test = { readRow, AAD_REFRESH, AAD_ACCESS };
