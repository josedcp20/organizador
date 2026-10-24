import type { PasskeyLoginResult } from '@organizador/shared';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { Hono } from 'hono';
import { fromBase64Url } from '../crypto/encoding';
import { importStateKey } from '../crypto/signedToken';
import { getPasskey, updatePasskeyUsage } from '../db/passkeys';
import { createSession } from '../db/sessions';
import type { AppEnv } from '../env';
import { errorBody } from '../errors';
import { clientGate, failure, resetFailures } from '../middleware/auth';
import { checkChallenge, consumeChallenge, issueChallenge } from '../webauthn/challenge';
import { rpConfig } from '../webauthn/config';

// Rutas PUBLICAS (en PUBLIC_API_ROUTES): sin Authorization; aplican el mismo bloqueo por IP que el token.
export const passkeyLogin = new Hono<AppEnv>();

const BODY_MAX = 16 * 1024;
const B64URL = /^[A-Za-z0-9_-]+$/;

async function setup(env: AppEnv['Bindings']) {
  const rp = rpConfig(env);
  const key = await importStateKey(env.OAUTH_STATE_KEY);
  return rp && key ? { rp, key } : null;
}

const notConfigured = () => errorBody('internal_error', 'Passkeys not configured');
/** Unico error de rechazo: no revela si la passkey existe ni que paso fallo. */
const invalidLogin = () => errorBody('invalid_login', 'Login rejected');

const isB64 = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max && B64URL.test(v);

/** Forma minima antes de tocar la libreria o D1. */
function parseAssertion(text: string): AuthenticationResponseJSON | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const r = (body as { response?: unknown } | null)?.response as
    AuthenticationResponseJSON | undefined;
  if (!r || typeof r !== 'object' || !isB64(r.id, 1024) || r.rawId !== r.id) return null;
  const a = r.response as Partial<AuthenticationResponseJSON['response']> | undefined;
  if (!a || typeof a !== 'object') return null;
  if (!isB64(a.clientDataJSON, BODY_MAX) || !isB64(a.authenticatorData, BODY_MAX)) return null;
  if (!isB64(a.signature, BODY_MAX)) return null;
  if (a.userHandle !== undefined && !isB64(a.userHandle, 1024)) return null;
  return r;
}

passkeyLogin.post('/api/passkeys/login/options', async (c) => {
  c.header('Cache-Control', 'no-store');
  // Solo lectura del bloqueo: emitir opciones no escribe en D1 (un anonimo no genera escrituras).
  const gate = await clientGate(c);
  if (gate instanceof Response) return gate;
  const cfg = await setup(c.env);
  if (!cfg) return c.json(notConfigured(), 500);
  const challenge = await issueChallenge(cfg.key, 'webauthn_login');
  const options = await generateAuthenticationOptions({
    rpID: cfg.rp.rpID,
    challenge: new Uint8Array(fromBase64Url(challenge)!),
    userVerification: 'required',
    timeout: 60000,
    // Credenciales descubribles: no se publican ids de credencial a un anonimo.
    allowCredentials: [],
  });
  return c.json(options);
});

passkeyLogin.post('/api/passkeys/login', async (c) => {
  c.header('Cache-Control', 'no-store');
  const gate = await clientGate(c);
  if (gate instanceof Response) return gate;
  const { key, t, hasRow } = gate;
  const fail = () => failure(c, key, t, invalidLogin());
  const cfg = await setup(c.env);
  if (!cfg) return c.json(notConfigured(), 500);

  if (Number(c.req.header('Content-Length') ?? 0) > BODY_MAX) return fail();
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return fail();
  }
  const response = text.length > BODY_MAX ? null : parseAssertion(text);
  if (!response) return fail();

  const pk = await getPasskey(c.env.DB, response.id);
  const publicKey = pk ? fromBase64Url(pk.publicKey) : null;
  if (!pk || !publicKey) return fail();

  const seen: { nonce?: string; exp?: number } = {};
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedOrigin: cfg.rp.origin,
      expectedRPID: cfg.rp.rpID,
      requireUserVerification: true,
      credential: {
        id: pk.id,
        publicKey: new Uint8Array(publicKey),
        // Apple siempre firma 0: con 0 guardado y 0 recibido la libreria lo acepta.
        counter: pk.signCount,
        ...(pk.transports ? { transports: pk.transports as ('internal' | 'hybrid')[] } : {}),
      },
      expectedChallenge: async (ch) => {
        const r = await checkChallenge(cfg.key, 'webauthn_login', ch, t);
        if (!r.ok) return false;
        seen.nonce = r.nonce;
        seen.exp = r.exp;
        return true;
      },
    });
  } catch {
    return fail();
  }
  if (!verified.verified || seen.nonce === undefined || seen.exp === undefined) return fail();
  // Un solo uso, consumido solo tras verificar la firma: de dos envios concurrentes gana uno.
  if (!(await consumeChallenge(c.env.DB, seen.nonce, seen.exp))) return fail();

  await updatePasskeyUsage(
    c.env.DB,
    pk.id,
    verified.authenticationInfo.newCounter,
    new Date(t).toISOString(),
  );
  const session = await createSession(c.env.DB, pk.id, t);
  if (hasRow) await resetFailures(c.env.DB, key, t);
  const out: PasskeyLoginResult = session;
  return c.json(out);
});
