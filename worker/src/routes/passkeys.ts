import type { PasskeyInfo, PasskeysResponse } from '@organizador/shared';
import { PASSKEY_LIMITS } from '@organizador/shared';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { Hono } from 'hono';
import { now } from '../clock';
import { fromBase64Url, toBase64Url } from '../crypto/encoding';
import { importStateKey } from '../crypto/signedToken';
import { deletePasskey, insertPasskey, listPasskeys, toPasskeyInfo } from '../db/passkeys';
import type { AppEnv } from '../env';
import { errorBody } from '../errors';
import { checkChallenge, consumeChallenge, issueChallenge } from '../webauthn/challenge';
import { rpConfig } from '../webauthn/config';

export const passkeys = new Hono<AppEnv>();

const NO_STORE = 'no-store';
const BODY_MAX = 16 * 1024;
const DEFAULT_LABEL = 'iPhone';
/** Usuario unico fijo, sin PII (16 bytes constantes). */
const USER_ID = new Uint8Array(new TextEncoder().encode('organizador-user'));

passkeys.use('/api/passkeys/*', async (c, next) => {
  c.header('Cache-Control', NO_STORE);
  await next();
});

async function setup(env: AppEnv['Bindings']) {
  const rp = rpConfig(env);
  const key = await importStateKey(env.OAUTH_STATE_KEY);
  return rp && key ? { rp, key } : null;
}

const notConfigured = () => errorBody('internal_error', 'Passkeys not configured');
const invalid = () => errorBody('invalid_registration', 'Registration rejected');
const staticOnly = () => errorBody('static_token_required', 'Static token required');

passkeys.post('/api/passkeys/register/options', async (c) => {
  if (c.get('authKind') !== 'static') return c.json(staticOnly(), 403);
  const cfg = await setup(c.env);
  if (!cfg) return c.json(notConfigured(), 500);
  const challenge = await issueChallenge(cfg.key, 'webauthn_reg');
  const existing = await listPasskeys(c.env.DB);
  const options = await generateRegistrationOptions({
    rpName: cfg.rp.rpName,
    rpID: cfg.rp.rpID,
    userID: USER_ID,
    userName: 'organizador',
    userDisplayName: 'Organizador',
    // El challenge es el token firmado; en bytes para que su base64url sea exactamente el emitido.
    challenge: new Uint8Array(fromBase64Url(challenge)!),
    attestationType: 'none',
    timeout: 60000,
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: existing.map((p) => ({
      id: p.id,
      ...(p.transports ? { transports: p.transports as ('internal' | 'hybrid')[] } : {}),
    })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    },
  });
  return c.json(options);
});

function sanitizeLabel(v: unknown): string {
  if (typeof v !== 'string') return DEFAULT_LABEL;
  const t = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, PASSKEY_LIMITS.labelMax).trim() || DEFAULT_LABEL;
}

const TRANSPORTS = ['internal', 'hybrid', 'usb', 'nfc', 'ble', 'smart-card'];
function cleanTransports(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((t) => TRANSPORTS.includes(t)) : null;
}

passkeys.post('/api/passkeys/register', async (c) => {
  if (c.get('authKind') !== 'static') return c.json(staticOnly(), 403);
  const cfg = await setup(c.env);
  if (!cfg) return c.json(notConfigured(), 500);

  if (Number(c.req.header('Content-Length') ?? 0) > BODY_MAX) {
    return c.json(errorBody('payload_too_large', 'Body too large'), 413);
  }
  let body: { response?: unknown; label?: unknown } | null;
  try {
    const text = await c.req.text();
    if (text.length > BODY_MAX)
      return c.json(errorBody('payload_too_large', 'Body too large'), 413);
    body = JSON.parse(text);
  } catch {
    return c.json(errorBody('validation', 'Body must be JSON'), 400);
  }
  const response = body?.response as RegistrationResponseJSON | undefined;
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
    return c.json(errorBody('validation', 'response is required'), 400);
  }

  const nowMs = now();
  const seen: { nonce?: string; exp?: number } = {};
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedOrigin: cfg.rp.origin,
      expectedRPID: cfg.rp.rpID,
      requireUserVerification: true,
      expectedChallenge: async (ch) => {
        const r = await checkChallenge(cfg.key, 'webauthn_reg', ch, nowMs);
        if (!r.ok) return false;
        seen.nonce = r.nonce;
        seen.exp = r.exp;
        return true;
      },
    });
  } catch {
    return c.json(invalid(), 400);
  }
  const info = verified.verified ? verified.registrationInfo : undefined;
  if (!info || seen.nonce === undefined || seen.exp === undefined) return c.json(invalid(), 400);
  // Un solo uso: se consume solo tras verificar la firma.
  if (!(await consumeChallenge(c.env.DB, seen.nonce, seen.exp))) return c.json(invalid(), 400);

  const row = {
    id: info.credential.id,
    publicKey: toBase64Url(info.credential.publicKey),
    transports: cleanTransports(response.response.transports),
    backedUp: info.credentialBackedUp,
    label: sanitizeLabel(body?.label),
    createdAt: new Date(nowMs).toISOString(),
  };
  const res = await insertPasskey(c.env.DB, row);
  if (res === 'duplicate') return c.json(errorBody('duplicate', 'Passkey already registered'), 409);
  if (res === 'limit') return c.json(errorBody('limit', 'Passkey limit reached'), 409);
  const out: PasskeyInfo = toPasskeyInfo({ ...row, signCount: 0, lastUsedAt: null });
  return c.json(out, 201);
});

passkeys.get('/api/passkeys', async (c) => {
  const body: PasskeysResponse = {
    passkeys: (await listPasskeys(c.env.DB)).map(toPasskeyInfo),
  };
  return c.json(body);
});

passkeys.delete('/api/passkeys/:id', async (c) => {
  if (!(await deletePasskey(c.env.DB, c.req.param('id')))) {
    return c.json(errorBody('not_found', 'Passkey not found'), 404);
  }
  return c.body(null, 204);
});
