import { env } from 'cloudflare:workers';
import type { PasskeyInfo, PasskeysResponse } from '@organizador/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setClock } from '../src/clock';
import { toBase64Url } from '../src/crypto/encoding';
import { importStateKey } from '../src/crypto/signedToken';
import { createSession } from '../src/db/sessions';
import { issueChallenge } from '../src/webauthn/challenge';
import { call, clearFailures, ORIGIN } from './helpers';
import { FakeAuthenticator } from './webauthnFake';

const KEY = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const IP = '8.8.8.8';
const E = { OAUTH_STATE_KEY: KEY };
const json = (o: unknown) => JSON.stringify(o);

const post = (path: string, body: unknown, auth?: string) =>
  call(path, { method: 'POST', ip: IP, env: E, body: json(body), ...(auth ? { auth } : {}) });
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

async function getChallenge(): Promise<string> {
  const r = await post('/api/passkeys/register/options', {});
  expect(r.status).toBe(200);
  return ((await r.json()) as { challenge: string }).challenge;
}

async function register(auth: FakeAuthenticator, label?: string, challenge?: string) {
  const ch = challenge ?? (await getChallenge());
  return post('/api/passkeys/register', { response: await auth.register(ch), label });
}

const count = async (t: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? 0;

beforeEach(async () => {
  await clearFailures();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM passkeys').run();
  await env.DB.prepare('DELETE FROM webauthn_challenges_used').run();
});
afterEach(() => setClock());

describe('register/options', () => {
  it('opciones correctas y excludeCredentials con las existentes', async () => {
    const a = await FakeAuthenticator.create();
    expect((await register(a)).status).toBe(201);
    const r = await post('/api/passkeys/register/options', {});
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    const o = (await r.json()) as {
      rp: { id: string; name: string };
      user: { name: string };
      attestation: string;
      authenticatorSelection: Record<string, string>;
      excludeCredentials: { id: string }[];
      challenge: string;
    };
    expect(o.rp).toEqual({ id: 'josedcp20.github.io', name: 'Organizador' });
    expect(o.attestation).toBe('none');
    expect(o.authenticatorSelection).toMatchObject({
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(o.excludeCredentials.map((c) => c.id)).toEqual([a.credentialId]);
    const key = (await importStateKey(KEY))!;
    expect(o.challenge).not.toBe(await issueChallenge(key, 'webauthn_reg'));
  });

  it('sesion -> 403 static_token_required', async () => {
    await env.DB.prepare(
      "INSERT INTO passkeys (id, public_key, label, created_at) VALUES ('pk1','k','x','x')",
    ).run();
    const { token } = await createSession(env.DB, 'pk1', Date.now());
    const r = await post('/api/passkeys/register/options', {}, `Bearer ${token}`);
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('static_token_required');
  });

  it('sin OAUTH_STATE_KEY -> 500 cerrado', async () => {
    const r = await call('/api/passkeys/register/options', {
      method: 'POST',
      ip: IP,
      env: { OAUTH_STATE_KEY: undefined },
    });
    expect(r.status).toBe(500);
  });
});

describe('register', () => {
  it('registro ok: 201 PasskeyInfo, label saneado, sin clave publica en la respuesta', async () => {
    const a = await FakeAuthenticator.create({ flags: { be: true, bs: true } });
    const r = await register(a, '  Mi\u0000  iPhone\n 15 ');
    expect(r.status).toBe(201);
    const info = (await r.json()) as PasskeyInfo;
    expect(info).toMatchObject({
      id: a.credentialId,
      label: 'Mi iPhone 15',
      lastUsedAt: null,
      backedUp: true,
    });
    expect(JSON.stringify(info)).not.toContain('public');
    const row = await env.DB.prepare('SELECT * FROM passkeys').first<{
      public_key: string;
      sign_count: number;
      transports: string;
    }>();
    expect(row?.public_key.length).toBeGreaterThan(20);
    expect(row?.transports).toBe('["internal"]');
    expect(await count('webauthn_challenges_used')).toBe(1);
  });

  it('label por defecto y recorte a 60', async () => {
    const a = await FakeAuthenticator.create();
    expect(((await (await register(a)).json()) as PasskeyInfo).label).toBe('iPhone');
    const b = await FakeAuthenticator.create();
    const info = (await (await register(b, 'x'.repeat(100))).json()) as PasskeyInfo;
    expect(info.label).toHaveLength(60);
  });

  it.each([
    ['origin distinto', { origin: 'https://evil.example' }],
    ['rpId distinto', { rpId: 'evil.example' }],
    ['sin UV', { flags: { uv: false } }],
    ['tipo webauthn.get', { type: 'webauthn.get' }],
  ])('%s -> 400 invalid_registration sin insertar', async (_n, opts) => {
    const a = await FakeAuthenticator.create(opts);
    const r = await register(a);
    expect(r.status).toBe(400);
    expect(await code(r)).toBe('invalid_registration');
    expect(await count('passkeys')).toBe(0);
    expect(await count('webauthn_challenges_used')).toBe(0);
  });

  it('challenge reutilizado -> 400 (y no inserta la segunda)', async () => {
    const ch = await getChallenge();
    const a = await FakeAuthenticator.create();
    expect((await register(a, undefined, ch)).status).toBe(201);
    const b = await FakeAuthenticator.create();
    const r = await register(b, undefined, ch);
    expect(r.status).toBe(400);
    expect(await code(r)).toBe('invalid_registration');
    expect(await count('passkeys')).toBe(1);
  });

  it('challenge caducado -> 400', async () => {
    const ch = await getChallenge();
    setClock(() => Date.now() + 10 * 60 * 1000);
    const r = await register(await FakeAuthenticator.create(), undefined, ch);
    expect(r.status).toBe(400);
    expect(await count('passkeys')).toBe(0);
  });

  it('challenge de login o inventado -> 400', async () => {
    const key = (await importStateKey(KEY))!;
    for (const ch of [
      await issueChallenge(key, 'webauthn_login'),
      toBase64Url(new Uint8Array(32)),
    ]) {
      const r = await register(await FakeAuthenticator.create(), undefined, ch);
      expect(r.status).toBe(400);
      expect(await code(r)).toBe('invalid_registration');
    }
    expect(await count('passkeys')).toBe(0);
  });

  it('sesion rechazada en registro (403), sin consumir challenge', async () => {
    await env.DB.prepare(
      "INSERT INTO passkeys (id, public_key, label, created_at) VALUES ('pk1','k','x','x')",
    ).run();
    const { token } = await createSession(env.DB, 'pk1', Date.now());
    const a = await FakeAuthenticator.create();
    const body = { response: await a.register(await getChallenge()) };
    const r = await post('/api/passkeys/register', body, `Bearer ${token}`);
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('static_token_required');
    expect(await count('webauthn_challenges_used')).toBe(0);
  });

  it('duplicado -> 409 duplicate', async () => {
    const a = await FakeAuthenticator.create();
    expect((await register(a)).status).toBe(201);
    const r = await register(a);
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('duplicate');
    expect(await count('passkeys')).toBe(1);
  });

  it('limite de 10 -> 409 limit', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await register(await FakeAuthenticator.create())).status).toBe(201);
    }
    const r = await register(await FakeAuthenticator.create());
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('limit');
    expect(await count('passkeys')).toBe(10);
  });

  it('Content-Length > 16 KB -> 413 antes de leer el cuerpo', async () => {
    const r = await call('/api/passkeys/register', {
      method: 'POST',
      ip: IP,
      env: E,
      headers: { 'Content-Length': String(16 * 1024 + 1) },
      body: '{}',
    });
    expect(r.status).toBe(413);
  });

  it('transports: solo array filtrado a valores conocidos; si no, null', async () => {
    const a = await FakeAuthenticator.create();
    const resp = await a.register(await getChallenge());
    (resp.response as { transports: unknown }).transports = ['internal', 'evil', 5, 'hybrid'];
    expect((await post('/api/passkeys/register', { response: resp })).status).toBe(201);
    const row = () =>
      env.DB.prepare('SELECT transports FROM passkeys').first<{ transports: string | null }>();
    expect((await row())?.transports).toBe('["internal","hybrid"]');

    await env.DB.prepare('DELETE FROM passkeys').run();
    const b = await FakeAuthenticator.create();
    const resp2 = await b.register(await getChallenge());
    (resp2.response as { transports: unknown }).transports = 'internal';
    expect((await post('/api/passkeys/register', { response: resp2 })).status).toBe(201);
    expect((await row())?.transports).toBeNull();
  });

  it('body invalido -> 400; > 16 KB -> 413', async () => {
    expect((await post('/api/passkeys/register', {})).status).toBe(400);
    const bad = await call('/api/passkeys/register', {
      method: 'POST',
      ip: IP,
      env: E,
      body: 'no json',
    });
    expect(bad.status).toBe(400);
    const big = await call('/api/passkeys/register', {
      method: 'POST',
      ip: IP,
      env: E,
      body: 'x'.repeat(17 * 1024),
    });
    expect(big.status).toBe(413);
  });

  it('sin token -> 401; CORS preflight OK', async () => {
    const r = await call('/api/passkeys/register', { method: 'POST', ip: IP, auth: null, env: E });
    expect(r.status).toBe(401);
    for (const [path, method] of [
      ['/api/passkeys/register/options', 'POST'],
      ['/api/passkeys/register', 'POST'],
      ['/api/passkeys', 'GET'],
      ['/api/passkeys/abc', 'DELETE'],
    ]) {
      const p = await call(path!, {
        method: 'OPTIONS',
        ip: IP,
        auth: null,
        origin: ORIGIN,
        headers: { 'Access-Control-Request-Method': method! },
      });
      expect(p.status).toBeLessThan(300);
      expect(p.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      expect(p.headers.get('Access-Control-Allow-Methods')).toContain(method!);
    }
  });
});

describe('lista y revocacion', () => {
  it('GET lista sin datos sensibles (token estatico y sesion)', async () => {
    const a = await FakeAuthenticator.create();
    await register(a, 'A');
    const { token } = await createSession(env.DB, a.credentialId, Date.now());
    for (const auth of [undefined, `Bearer ${token}`]) {
      const r = await call('/api/passkeys', { ip: IP, ...(auth ? { auth } : {}) });
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(text).not.toMatch(/public|sign_?count|publicKey/i);
      const body = JSON.parse(text) as PasskeysResponse;
      expect(body.passkeys).toHaveLength(1);
      expect(Object.keys(body.passkeys[0]!).sort()).toEqual(
        ['backedUp', 'createdAt', 'id', 'label', 'lastUsedAt'].sort(),
      );
    }
  });

  it('DELETE borra la passkey y solo sus sesiones; 404 si no existe', async () => {
    const a = await FakeAuthenticator.create();
    const b = await FakeAuthenticator.create();
    await register(a);
    await register(b);
    const sa = await createSession(env.DB, a.credentialId, Date.now());
    await createSession(env.DB, b.credentialId, Date.now());
    const r = await call(`/api/passkeys/${a.credentialId}`, { method: 'DELETE', ip: IP });
    expect(r.status).toBe(204);
    expect(await count('passkeys')).toBe(1);
    expect(await count('sessions')).toBe(1);
    expect((await call('/api/me', { ip: IP, auth: `Bearer ${sa.token}` })).status).toBe(401);
    const again = await call(`/api/passkeys/${a.credentialId}`, { method: 'DELETE', ip: IP });
    expect(again.status).toBe(404);
    expect(await code(again)).toBe('not_found');
  });

  it('una sesion puede revocar (D-FID4), incluso su propia passkey', async () => {
    const a = await FakeAuthenticator.create();
    await register(a);
    const s = await createSession(env.DB, a.credentialId, Date.now());
    const r = await call(`/api/passkeys/${a.credentialId}`, {
      method: 'DELETE',
      ip: IP,
      auth: `Bearer ${s.token}`,
    });
    expect(r.status).toBe(204);
    expect(await count('passkeys')).toBe(0);
    expect(await count('sessions')).toBe(0);
  });
});
