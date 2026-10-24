import { env } from 'cloudflare:workers';
import type { MeResponse, PasskeyLoginResult } from '@organizador/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setClock } from '../src/clock';
import { toBase64Url } from '../src/crypto/encoding';
import { MAX_FAILURES } from '../src/middleware/auth';
import { call, clearFailures, failureRowCount } from './helpers';
import { FakeAuthenticator } from './webauthnFake';

const KEY = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const IP = '7.7.7.7';
const E = { OAUTH_STATE_KEY: KEY };

const pub = (path: string, body?: BodyInit, ip = IP) =>
  call(path, { method: 'POST', ip, env: E, auth: null, ...(body !== undefined ? { body } : {}) });
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const count = async (t: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? 0;

async function loginChallenge(ip = IP): Promise<string> {
  const r = await pub('/api/passkeys/login/options', undefined, ip);
  expect(r.status).toBe(200);
  return ((await r.json()) as { challenge: string }).challenge;
}

/** Registra la passkey del autenticador por la API (token estatico). */
async function registerVia(a: FakeAuthenticator): Promise<void> {
  const o = await call('/api/passkeys/register/options', { method: 'POST', ip: IP, env: E });
  const { challenge } = (await o.json()) as { challenge: string };
  const r = await call('/api/passkeys/register', {
    method: 'POST',
    ip: IP,
    env: E,
    body: JSON.stringify({ response: await a.register(challenge) }),
  });
  expect(r.status).toBe(201);
}

const login = (response: unknown, ip = IP) =>
  pub('/api/passkeys/login', JSON.stringify({ response }), ip);

async function expectRejected(r: Response) {
  expect(r.status).toBe(401);
  expect(r.headers.get('Cache-Control')).toBe('no-store');
  expect(await code(r)).toBe('invalid_login');
}

let a: FakeAuthenticator;

beforeEach(async () => {
  await clearFailures();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM passkeys').run();
  await env.DB.prepare('DELETE FROM webauthn_challenges_used').run();
  a = await FakeAuthenticator.create();
  await registerVia(a);
  await clearFailures();
});
afterEach(() => setClock());

describe('login/options', () => {
  it('publico, sin ids de credencial, UV requerido y 0 escrituras', async () => {
    const before = [await count('auth_failures'), await count('webauthn_challenges_used')];
    const r = await pub('/api/passkeys/login/options');
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    const o = (await r.json()) as Record<string, unknown>;
    expect(o).toMatchObject({ rpId: 'josedcp20.github.io', userVerification: 'required' });
    expect(o.allowCredentials ?? []).toEqual([]);
    expect(typeof o.challenge).toBe('string');
    expect([await count('auth_failures'), await count('webauthn_challenges_used')]).toEqual(before);
  });

  it('sin CF-Connecting-IP fuera de dev -> 500', async () => {
    const r = await call('/api/passkeys/login/options', { method: 'POST', env: E, auth: null });
    expect(r.status).toBe(500);
  });

  it('sin OAUTH_STATE_KEY -> 500 sin contar fallo', async () => {
    const r = await call('/api/passkeys/login', {
      method: 'POST',
      ip: IP,
      auth: null,
      env: { OAUTH_STATE_KEY: '' },
      body: '{}',
    });
    expect(r.status).toBe(500);
    expect(await failureRowCount()).toBe(0);
  });
});

describe('login', () => {
  it('asercion valida -> sesion usable en /api/me; actualiza contador y ultimo uso', async () => {
    const r = await login(await a.assert(await loginChallenge(), { counter: 7 }));
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    const s = (await r.json()) as PasskeyLoginResult;
    expect(s.token).toMatch(/^s1\./);
    const me = await call('/api/me', { ip: IP, auth: `Bearer ${s.token}` });
    expect(me.status).toBe(200);
    const body = (await me.json()) as MeResponse;
    expect(body.auth).toBe('session');
    expect(body.sessionExpiresAt).toBe(s.expiresAt);
    const row = await env.DB.prepare('SELECT sign_count, last_used_at FROM passkeys').first<{
      sign_count: number;
      last_used_at: string | null;
    }>();
    expect(row?.sign_count).toBe(7);
    expect(row?.last_used_at).not.toBeNull();
  });

  it('contador 0 (Apple) aceptado en logins repetidos', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await login(await a.assert(await loginChallenge(), { counter: 0 }));
      expect(r.status).toBe(200);
    }
    expect(await count('sessions')).toBe(2);
  });

  it('contador que retrocede (con contador > 0) -> 401', async () => {
    expect((await login(await a.assert(await loginChallenge(), { counter: 5 }))).status).toBe(200);
    await expectRejected(await login(await a.assert(await loginChallenge(), { counter: 5 })));
    await expectRejected(await login(await a.assert(await loginChallenge(), { counter: 3 })));
  });

  it('acierto resetea los fallos previos', async () => {
    await expectRejected(await pub('/api/passkeys/login', 'no-json'));
    expect(await failureRowCount()).toBe(1);
    expect((await login(await a.assert(await loginChallenge()))).status).toBe(200);
    expect(await failureRowCount()).toBe(0);
  });

  it('credencial desconocida y sin passkeys registradas -> 401 identico y cuenta fallo', async () => {
    const other = await FakeAuthenticator.create();
    await expectRejected(await login(await other.assert(await loginChallenge())));
    await env.DB.prepare('DELETE FROM passkeys').run();
    await expectRejected(await login(await a.assert(await loginChallenge())));
    expect(await count('sessions')).toBe(0);
    const row = await env.DB.prepare('SELECT count FROM auth_failures').first<{ count: number }>();
    expect(row?.count).toBe(2);
  });

  it('firma mala -> 401', async () => {
    const resp = await a.assert(await loginChallenge());
    const sig = resp.response.signature;
    // Altera un byte dentro de r (DER sigue siendo valido).
    resp.response.signature = sig.slice(0, 20) + (sig[20] === 'A' ? 'B' : 'A') + sig.slice(21);
    // Firma de otra clave sobre el mismo id: tambien rechazada.
    const other = await FakeAuthenticator.create();
    const forged = await other.assert(await loginChallenge());
    forged.id = forged.rawId = a.credentialId;
    await expectRejected(await login(resp));
    await expectRejected(await login(forged));
  });

  it('origin malo, rpId malo, sin UV o tipo de registro -> 401', async () => {
    for (const o of [
      { origin: 'https://evil.example' },
      { origin: 'https://josedcp20.github.io.evil.example' },
      { rpId: 'evil.example' },
      { flags: { uv: false } },
      { flags: { up: false } },
      { type: 'webauthn.create' },
    ]) {
      await expectRejected(await login(await a.assert(await loginChallenge(), o)));
    }
    expect(await count('sessions')).toBe(0);
    // Solo el challenge del registro del beforeEach: ningun rechazo consume el suyo.
    expect(await count('webauthn_challenges_used')).toBe(1);
  });

  it('challenge reutilizado (replay) -> 401', async () => {
    const resp = await a.assert(await loginChallenge());
    expect((await login(resp)).status).toBe(200);
    await expectRejected(await login(resp));
    expect(await count('sessions')).toBe(1);
  });

  it('dos logins concurrentes con el mismo challenge -> una sola sesion', async () => {
    const resp = await a.assert(await loginChallenge());
    const rs = await Promise.all([login(resp), login(resp)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await count('sessions')).toBe(1);
  });

  it('challenge caducado -> 401', async () => {
    const resp = await a.assert(await loginChallenge());
    setClock(() => Date.now() + 6 * 60 * 1000);
    await expectRejected(await login(resp));
  });

  it('challenge de registro o inventado -> 401', async () => {
    const o = await call('/api/passkeys/register/options', { method: 'POST', ip: IP, env: E });
    const { challenge } = (await o.json()) as { challenge: string };
    await expectRejected(await login(await a.assert(challenge)));
    await expectRejected(await login(await a.assert(toBase64Url(new Uint8Array(32)))));
  });

  it('cuerpo malformado o > 16 KB -> 401 y cuenta fallo', async () => {
    const good = await a.assert(await loginChallenge());
    const bodies = [
      'no-json',
      '{}',
      JSON.stringify({ response: { ...good, rawId: 'x' } }),
      JSON.stringify({ response: { ...good, response: { ...good.response, signature: '!!' } } }),
      JSON.stringify({ response: good, pad: 'x'.repeat(16 * 1024) }),
    ];
    for (const b of bodies) await expectRejected(await pub('/api/passkeys/login', b));
    const row = await env.DB.prepare('SELECT count FROM auth_failures').first<{ count: number }>();
    expect(row?.count).toBe(bodies.length);
  });

  it('Content-Length > 16 KB -> 401 uniforme y cuenta fallo', async () => {
    const r = await call('/api/passkeys/login', {
      method: 'POST',
      ip: IP,
      env: E,
      auth: null,
      headers: { 'Content-Length': String(16 * 1024 + 1) },
      body: '{}',
    });
    await expectRejected(r);
    expect(await failureRowCount()).toBe(1);
  });

  it('DELETE/GET a /api/passkeys/login (tambien codificado) sin token -> 401 y cuentan fallo', async () => {
    let n = 0;
    for (const [method, path] of [
      ['DELETE', '/api/passkeys/login'],
      ['GET', '/api/passkeys/login'],
      ['DELETE', '/api/passkeys/%6Cogin'],
      ['DELETE', '/api/passkeys/login/options'],
    ] as const) {
      const r = await call(path, { method, ip: IP, env: E, auth: null });
      expect(r.status).toBe(401);
      expect(await code(r)).toBe('unauthorized');
      n++;
      const row = await env.DB.prepare('SELECT count FROM auth_failures').first<{
        count: number;
      }>();
      expect(row?.count).toBe(n);
    }
  });

  it(`${MAX_FAILURES} fallos -> 429 en login y en login/options (otra IP no afectada)`, async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      await expectRejected(await pub('/api/passkeys/login', '{}'));
    }
    const valid = await a.assert(await loginChallenge('8.8.4.4'));
    const blocked = await login(valid);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await pub('/api/passkeys/login/options')).status).toBe(429);
    // El token estatico tambien queda bloqueado: mismo contador por IP.
    expect((await call('/api/me', { ip: IP })).status).toBe(429);
    expect((await login(valid, '8.8.4.4')).status).toBe(200);
  });

  it('revocar la passkey invalida su sesion', async () => {
    const s = (await (
      await login(await a.assert(await loginChallenge()))
    ).json()) as PasskeyLoginResult;
    const del = await call(`/api/passkeys/${a.credentialId}`, { method: 'DELETE', ip: IP, env: E });
    expect(del.status).toBe(204);
    expect((await call('/api/me', { ip: IP, auth: `Bearer ${s.token}` })).status).toBe(401);
    await expectRejected(await login(await a.assert(await loginChallenge())));
  });

  it('CORS preflight de las rutas publicas', async () => {
    const r = await call('/api/passkeys/login', {
      method: 'OPTIONS',
      origin: 'https://josedcp20.github.io',
      auth: null,
      headers: { 'Access-Control-Request-Method': 'POST' },
    });
    expect(r.status).toBe(204);
  });
});
