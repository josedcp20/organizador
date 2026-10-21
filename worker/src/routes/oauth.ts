import type { GoogleConnectReason, GoogleTicketResponse } from '@organizador/shared';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { now } from '../clock';
import { newNonce, signToken, verifyToken } from '../crypto/signedToken';
import type { Env } from '../env';
import { errorBody } from '../errors';
import {
  buildConsentUrl,
  checkScopes,
  disconnectGoogle,
  exchangeCode,
  getGoogleStatus,
  loadOAuthConfig,
  markConnectionRevoked,
  pkcePair,
  revokeToken,
  saveConnection,
} from '../google/oauth';
import { consumeOneTime, purgeExpiredOneTime, storeOneTime } from '../google/oauthStore';

/**
 * Flujo OAuth con Google (seccion 4-6 del plan):
 * 1. `POST /api/oauth/google/ticket` (Bearer): ticket firmado de un solo uso, 60 s.
 * 2. `GET /oauth/google/start?ticket=` (publico): canjea el ticket y redirige a Google con
 *    `state` firmado de un solo uso + PKCE.
 * 3. `GET /oauth/google/callback` (publico): valida state, intercambia el code, verifica el
 *    conjunto de scopes y guarda el refresh token cifrado; vuelve a `APP_URL#/ajustes?google=...`.
 *
 * Las rutas /oauth/* son publicas: nunca devuelven detalles, solo redirigen a APP_URL (valor fijo
 * de configuracion, jamas de la query) con un motivo de una lista cerrada.
 */
export const TICKET_TTL_MS = 60 * 1000;
export const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_LENGTH = 2048;

export const oauth = new Hono<{ Bindings: Env }>();

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

function appUrl(env: Env): URL | null {
  try {
    const url = new URL(env.APP_URL);
    const local =
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.protocol !== 'https:' && !local) return null;
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function backToApp(c: Context<{ Bindings: Env }>, reason?: GoogleConnectReason): Response {
  const url = appUrl(c.env);
  if (!url) {
    console.error('oauth_misconfigured', 'bad_app_url');
    return new Response('Error', { status: 500, headers: NO_STORE });
  }
  url.hash = reason ? `/ajustes?google=error&reason=${reason}` : '/ajustes?google=ok';
  return new Response(null, { status: 302, headers: { ...NO_STORE, Location: url.toString() } });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { ...NO_STORE, Location: location } });
}

// 1. Ticket (protegido por el middleware Bearer de /api/*).
oauth.post('/api/oauth/google/ticket', async (c) => {
  const cfg = await loadOAuthConfig(c.env);
  if (!cfg) {
    console.error('oauth_misconfigured', 'missing_google_config');
    return c.json(errorBody('misconfigured', 'Google OAuth is not configured'), 500);
  }
  const t = now();
  await purgeExpiredOneTime(c.env.DB, t);
  const nonce = newNonce();
  const exp = t + TICKET_TTL_MS;
  await storeOneTime(c.env.DB, 'ticket', nonce, exp, t);
  const body: GoogleTicketResponse = {
    ticket: await signToken(cfg.stateKey, 'ticket', nonce, exp),
    expiresIn: TICKET_TTL_MS / 1000,
  };
  c.header('Cache-Control', 'no-store');
  return c.json(body);
});

// 2. Inicio (publico; la autorizacion es el ticket).
oauth.get('/oauth/google/start', async (c) => {
  try {
    const cfg = await loadOAuthConfig(c.env);
    if (!cfg) return backToApp(c, 'misconfigured');
    const t = now();
    const v = await verifyToken(cfg.stateKey, 'ticket', c.req.query('ticket'), t);
    if (!v.ok) return backToApp(c, 'invalid_ticket');
    if (!(await consumeOneTime(c.env.DB, 'ticket', v.nonce, t))) {
      return backToApp(c, 'invalid_ticket');
    }
    const nonce = newNonce();
    const exp = t + STATE_TTL_MS;
    const { verifier, challenge } = await pkcePair();
    await storeOneTime(c.env.DB, 'state', nonce, exp, t, { verifier });
    const state = await signToken(cfg.stateKey, 'state', nonce, exp);
    return redirectTo(buildConsentUrl(cfg, state, challenge));
  } catch (err) {
    console.error('oauth_start_error', err instanceof Error ? err.name : 'unknown');
    return backToApp(c, 'internal');
  }
});

// 3. Callback (publico; la autorizacion es el state).
oauth.get('/oauth/google/callback', async (c) => {
  try {
    const cfg = await loadOAuthConfig(c.env);
    if (!cfg) return backToApp(c, 'misconfigured');
    const t = now();
    const v = await verifyToken(cfg.stateKey, 'state', c.req.query('state'), t);
    if (!v.ok) return backToApp(c, 'invalid_state');
    const stored = await consumeOneTime(c.env.DB, 'state', v.nonce, t);
    if (!stored?.verifier) return backToApp(c, 'invalid_state');

    const error = c.req.query('error');
    if (error) return backToApp(c, error === 'access_denied' ? 'access_denied' : 'invalid_request');
    const code = c.req.query('code');
    if (!code || code.length > MAX_CODE_LENGTH) return backToApp(c, 'invalid_request');

    const tokens = await exchangeCode(cfg, code, stored.verifier);
    if (!tokens) return backToApp(c, 'exchange_failed');

    // Escritura acotada: el conjunto concedido debe ser EXACTAMENTE GOOGLE_SCOPES.
    const check = checkScopes(tokens.scope);
    if (!check.ok) {
      if (check.extra.length > 0 || check.granted.length === 0) {
        // Sobra algun permiso (p. ej. `.../auth/calendar` completo), o Google no informa del
        // scope concedido (no se puede comprobar): revocar y rechazar.
        await revokeToken(tokens.refresh_token ?? tokens.access_token);
        // La revocacion invalida toda la concesion: una conexion previa tambien queda muerta.
        await markConnectionRevoked(c.env.DB);
        console.warn('google_oauth', 'scope_rejected_revoked');
        return backToApp(c, check.extra.length > 0 ? 'extra_scope' : 'missing_scope');
      }
      // Falta un permiso (el usuario desmarco la casilla de eventos): rechazar. No se revoca
      // para no invalidar una conexion previa valida del mismo usuario.
      console.warn('google_oauth', 'missing_scope');
      return backToApp(c, 'missing_scope');
    }
    if (!tokens.refresh_token) return backToApp(c, 'no_refresh_token');

    await saveConnection(
      c.env.DB,
      cfg,
      { ...tokens, refresh_token: tokens.refresh_token },
      check.scopes,
      t,
    );
    // TODO(T2.3): importar calendarList tras conectar.
    return backToApp(c);
  } catch (err) {
    console.error('oauth_callback_error', err instanceof Error ? err.name : 'unknown');
    return backToApp(c, 'internal');
  }
});

// Estado y desconexion (Bearer).
oauth.get('/api/google/status', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(await getGoogleStatus(c.env));
});

async function disconnect(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { revoked } = await disconnectGoogle(c.env);
  return c.json({ ok: true, revoked });
}

oauth.post('/api/google/disconnect', disconnect);
// Alias de la tabla de endpoints del plan (seccion 4).
oauth.delete('/api/oauth/google', disconnect);
