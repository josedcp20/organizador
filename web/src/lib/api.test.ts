import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { apiFetch, ApiError, getApiBase, clearApiCaches, logout } from './api';
import { setToken, getToken, clearToken, isLoggedIn, session } from './auth';

const BASE = 'https://worker.example.workers.dev';

function json(body: unknown, init: ConstructorParameters<typeof Response>[1] = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

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
  clearToken();
});

describe('auth store', () => {
  it('guarda, lee y borra el token', () => {
    expect(isLoggedIn()).toBe(false);
    setToken('abc');
    expect(getToken()).toBe('abc');
    expect(localStorage.getItem('organizador_token')).toBe('abc');
    expect(get(session)).toBe(true);
    clearToken();
    expect(getToken()).toBeNull();
    expect(get(session)).toBe(false);
  });
});

describe('getApiBase (fail-closed)', () => {
  it('lanza sin VITE_API_BASE y no hace fetch', async () => {
    vi.stubEnv('VITE_API_BASE', '');
    setToken('t');
    expect(() => getApiBase()).toThrow(ApiError);
    await expect(apiFetch('/api/me')).rejects.toMatchObject({ code: 'config' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechaza http no local y acepta https y localhost', () => {
    vi.stubEnv('VITE_API_BASE', 'http://evil.example.com');
    expect(() => getApiBase()).toThrow();
    vi.stubEnv('VITE_API_BASE', 'http://localhost:8787');
    expect(getApiBase()).toBe('http://localhost:8787');
    vi.stubEnv('VITE_API_BASE', 'http://127.0.0.1:8787');
    expect(getApiBase()).toBe('http://127.0.0.1:8787');
    vi.stubEnv('VITE_API_BASE', BASE + '/');
    expect(getApiBase()).toBe(BASE);
  });
});

describe('apiFetch', () => {
  it.each([
    'https://evil.com/api/me',
    '//evil.com/api/me',
    '/api/../secret',
    '/other/me',
    'api/me',
    '/api/%2e%2e/x',
    '/api/\\x',
  ])('rechaza endpoint %s', async (ep) => {
    setToken('t');
    await expect(apiFetch(ep)).rejects.toMatchObject({ code: 'bad_endpoint' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('envia Authorization Bearer', async () => {
    setToken('secret');
    fetchMock.mockResolvedValue(json({ ok: true }));
    await apiFetch('/api/me');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/me`);
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(init.credentials).toBe('omit');
  });

  it('sin token no llama a /api/* salvo health (sin Authorization)', async () => {
    await expect(apiFetch('/api/me')).rejects.toMatchObject({ code: 'no_token' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(json({ ok: true }));
    await apiFetch('/api/health');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('401 => borra token, limpia caches y vuelve a login', async () => {
    setToken('bad');
    const del = vi.fn().mockResolvedValue(true);
    const apiReq = new Request(`${BASE}/api/me`);
    const otherReq = new Request('https://x.test/assets/a.js');
    vi.stubGlobal('caches', {
      keys: async () => ['c1'],
      open: async () => ({ keys: async () => [apiReq, otherReq], delete: del }),
    });
    fetchMock.mockResolvedValue(
      json({ error: { code: 'unauthorized', message: 'No autorizado' } }, { status: 401 }),
    );
    await expect(apiFetch('/api/me')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(getToken()).toBeNull();
    expect(window.location.hash).toBe('#/login');
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(apiReq);
  });

  it('401 con token explicito (login) no cierra la sesion existente', async () => {
    setToken('good');
    fetchMock.mockResolvedValue(
      json({ error: { code: 'unauthorized', message: 'x' } }, { status: 401 }),
    );
    await expect(apiFetch('/api/me', { token: 'other' })).rejects.toMatchObject({ status: 401 });
    expect(getToken()).toBe('good');
  });

  it('429 no reintenta y expone Retry-After', async () => {
    setToken('t');
    fetchMock.mockResolvedValue(
      json(
        { error: { code: 'rate_limited', message: 'Bloqueado' } },
        { status: 429, headers: { 'Retry-After': '900' } },
      ),
    );
    await expect(apiFetch('/api/me')).rejects.toMatchObject({ status: 429, retryAfter: 900 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getToken()).toBe('t');
  });

  it('error de red => ApiError network', async () => {
    setToken('t');
    fetchMock.mockRejectedValue(new TypeError('fail'));
    await expect(apiFetch('/api/me')).rejects.toMatchObject({ code: 'network' });
  });
});

describe('logout', () => {
  it('borra token, caches y navega a login', async () => {
    setToken('t');
    await logout();
    expect(getToken()).toBeNull();
    expect(window.location.hash).toBe('#/login');
    await expect(clearApiCaches()).resolves.toBeUndefined();
  });
});

describe('ApiError.body', () => {
  it('conserva el cuerpo JSON de un 409 (current)', async () => {
    setToken('t');
    fetchMock.mockResolvedValue(
      json({ error: { code: 'conflict', message: 'x' }, current: { id: 'e1' } }, { status: 409 }),
    );
    const err = await apiFetch('/api/agenda/c/e').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body).toMatchObject({ current: { id: 'e1' } });
  });

  it('un 500 sin JSON deja body undefined', async () => {
    setToken('t');
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const err = (await apiFetch('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(500);
    expect(err.body).toBeUndefined();
  });
});
