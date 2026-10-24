import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  b64urlToBuffer,
  bufferToB64url,
  passkeySupported,
  platformAvailable,
  registerPasskey,
  authenticatePasskey,
  PasskeyError,
  loginWithPasskey,
  fetchLoginOptions,
  revokePasskey,
} from './passkeys';
import { logout } from './api';
import { setToken, clearToken, isSessionToken } from './auth';

const BASE = 'https://worker.example.workers.dev';
const bytes = (...n: number[]) => new Uint8Array(n).buffer;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_BASE', BASE);
  clearToken();
  window.location.hash = '#/hoy';
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
  clearToken();
});

function mockCreds(impl: { create?: unknown; get?: unknown }) {
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
  };
  Object.defineProperty(navigator, 'credentials', { value: impl, configurable: true });
}

describe('base64url', () => {
  it('ida y vuelta', () => {
    const b = bytes(251, 255, 0, 62, 63);
    const s = bufferToB64url(b);
    expect(s).toBe('-_8APj8');
    expect([...new Uint8Array(b64urlToBuffer(s))]).toEqual([251, 255, 0, 62, 63]);
  });
});

describe('soporte', () => {
  it('seguro sin PublicKeyCredential', async () => {
    expect(passkeySupported()).toBe(false);
    expect(await platformAvailable()).toBe(false);
  });
  it('detecta autenticador de plataforma', async () => {
    mockCreds({});
    expect(passkeySupported()).toBe(true);
    expect(await platformAvailable()).toBe(true);
  });
});

describe('ceremonias', () => {
  it('registerPasskey serializa la respuesta', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'cid',
      rawId: bytes(1, 2),
      response: {
        clientDataJSON: bytes(3),
        attestationObject: bytes(4),
        getTransports: () => ['internal', 'usb'],
      },
    });
    mockCreds({ create });
    const out = await registerPasskey({
      challenge: 'AQ',
      rp: { name: 'O' },
      user: { id: 'Ag', name: 'u', displayName: 'U' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: [{ id: 'Aw', type: 'public-key' }],
    });
    expect(out).toEqual({
      id: 'cid',
      rawId: 'AQI',
      response: { clientDataJSON: 'Aw', attestationObject: 'BA', transports: ['internal'] },
      type: 'public-key',
    });
    const arg = create.mock.calls[0][0].publicKey;
    expect(arg.challenge).toBeInstanceOf(ArrayBuffer);
    expect(arg.excludeCredentials[0].id).toBeInstanceOf(ArrayBuffer);
  });

  it('authenticatePasskey serializa la asercion', async () => {
    const get = vi.fn().mockResolvedValue({
      id: 'cid',
      rawId: bytes(1),
      response: {
        clientDataJSON: bytes(2),
        authenticatorData: bytes(3),
        signature: bytes(4),
        userHandle: bytes(5),
      },
    });
    mockCreds({ get });
    const out = await authenticatePasskey({ challenge: 'AQ', allowCredentials: [] });
    expect(out.response).toEqual({
      clientDataJSON: 'Ag',
      authenticatorData: 'Aw',
      signature: 'BA',
      userHandle: 'BQ',
    });
  });

  it.each([
    ['NotAllowedError', 'cancelled'],
    ['InvalidStateError', 'already_registered'],
    ['SecurityError', 'security'],
    ['NotSupportedError', 'unsupported'],
    ['Otro', 'failed'],
  ])('mapea %s a %s', async (name, code) => {
    mockCreds({ get: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name })) });
    const p = authenticatePasskey({ challenge: 'AQ' });
    await expect(p).rejects.toBeInstanceOf(PasskeyError);
    await expect(p).rejects.toMatchObject({ code });
  });

  it('unsupported sin soporte', async () => {
    await expect(authenticatePasskey({ challenge: 'AQ' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('API publica y logout', () => {
  const ok = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

  it('login/options y login no llevan Authorization aunque haya token', async () => {
    setToken('static');
    fetchMock.mockResolvedValueOnce(ok({ challenge: 'x' }));
    await fetchLoginOptions();
    fetchMock.mockResolvedValueOnce(ok({ token: 's1.a', expiresAt: 'z' }));
    const r = await loginWithPasskey({} as never);
    expect(r.token).toBe('s1.a');
    for (const c of fetchMock.mock.calls) expect(c[1].headers.Authorization).toBeUndefined();
  });

  it('401 en login no cierra sesion', async () => {
    setToken('static');
    fetchMock.mockResolvedValueOnce(ok({ error: { code: 'unauthorized', message: 'no' } }, 401));
    await expect(loginWithPasskey({} as never)).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem('organizador_token')).toBe('static');
  });

  it('revokePasskey usa el id base64url', async () => {
    setToken('t');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await revokePasskey('a-b_c');
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/passkeys/a-b_c`);
  });

  it('logout llama a session/logout solo con token s1. y no bloquea si falla', async () => {
    setToken('s1.abc');
    expect(isSessionToken()).toBe(true);
    fetchMock.mockRejectedValue(new Error('net'));
    await logout();
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/session/logout`);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer s1.abc');
    expect(localStorage.getItem('organizador_token')).toBeNull();

    fetchMock.mockClear();
    setToken('estatico');
    await logout();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
