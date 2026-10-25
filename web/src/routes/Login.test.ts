import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import * as passkeys from '../lib/passkeys';
import Login from './Login.svelte';
import App from '../App.svelte';
import { getToken, clearToken, setToken, meInfo } from '../lib/auth';

const BASE = 'https://worker.example.workers.dev';
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, init: ConstructorParameters<typeof Response>[1] = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

const unauthorized = () => json({ error: { code: 'unauthorized', message: 'x' } }, { status: 401 });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_BASE', BASE);
  clearToken();
  window.location.hash = '#/login';
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearToken();
});

async function submit(token: string) {
  const input = screen.getByLabelText('Token de acceso') as HTMLInputElement;
  await fireEvent.input(input, { target: { value: token } });
  await fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
}

describe('Login', () => {
  it('token valido: guarda, entra a #/hoy y expone /api/me', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, version: '1.2.3', tz: 'Europe/Madrid' }));
    render(Login);
    await submit('good');
    await waitFor(() => expect(getToken()).toBe('good'));
    await waitFor(() => expect(window.location.hash).toBe('#/hoy'));
    expect(get(meInfo)).toEqual({ version: '1.2.3', tz: 'Europe/Madrid' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer good');
  });

  it('token invalido: error y no guarda', async () => {
    fetchMock.mockResolvedValue(unauthorized());
    render(Login);
    await submit('bad');
    expect((await screen.findByRole('alert')).textContent).toMatch(/no válido/);
    expect(getToken()).toBeNull();
    expect(window.location.hash).toBe('#/login');
  });

  it('429: mensaje de bloqueo temporal', async () => {
    fetchMock.mockResolvedValue(
      json(
        { error: { code: 'rate_limited', message: 'x' } },
        { status: 429, headers: { 'Retry-After': '900' } },
      ),
    );
    render(Login);
    await submit('x');
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /bloqueado temporalmente.*15 min/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('red: mensaje de conexion', async () => {
    fetchMock.mockRejectedValue(new TypeError('down'));
    render(Login);
    await submit('x');
    expect((await screen.findByRole('alert')).textContent).toMatch(/conexión/);
  });

  it('?token= valido: se lee, se prueba y se elimina de la URL', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, version: '1', tz: 'UTC' }));
    window.location.hash = '#/login?token=XYZ';
    render(Login);
    expect(window.location.hash).toBe('#/login');
    expect(window.location.href).not.toContain('XYZ');
    await waitFor(() => expect(getToken()).toBe('XYZ'));
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer XYZ');
    expect(JSON.stringify(window.history.state ?? null)).not.toContain('XYZ');
  });

  it('?token= invalido: tambien se elimina de la URL y no se guarda', async () => {
    fetchMock.mockResolvedValue(unauthorized());
    window.location.hash = '#/login?token=BAD';
    render(Login);
    expect(window.location.hash).toBe('#/login');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(window.location.href).not.toContain('BAD');
    expect(getToken()).toBeNull();
    expect((screen.getByLabelText('Token de acceso') as HTMLInputElement).value).toBe('');
  });
});

describe('Login con Face ID', () => {
  const opts = { challenge: 'abc' };
  const assertion = { id: 'i', rawId: 'i', response: {}, type: 'public-key' };
  let getSpy: ReturnType<typeof vi.spyOn>;

  function mockPasskeys(available = true) {
    vi.spyOn(passkeys, 'passkeySupported').mockReturnValue(available);
    vi.spyOn(passkeys, 'platformAvailable').mockResolvedValue(available);
    getSpy = vi.spyOn(passkeys, 'authenticatePasskey').mockResolvedValue(assertion as never);
  }
  // Espera a que las opciones precargadas esten guardadas: en CI el click llegaba antes y la carga seguia en vuelo.
  const faceBtn = async () => {
    const btn = await screen.findByRole('button', { name: 'Entrar con Face ID' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    return btn;
  };
  const apiErr = (status: number, retry?: string) =>
    json(
      { error: { code: 'x', message: 'x' } },
      { status, headers: retry ? { 'Retry-After': retry } : {} },
    );

  afterEach(() => vi.restoreAllMocks());

  it('sin soporte: no hay boton ni peticion de opciones', async () => {
    mockPasskeys(false);
    render(Login);
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: 'Entrar con Face ID' })).toBeNull();
    expect(screen.getByLabelText('Token de acceso')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exito: opciones precargadas, sesion guardada y entra a #/hoy', async () => {
    mockPasskeys();
    fetchMock
      .mockResolvedValueOnce(json(opts))
      .mockResolvedValueOnce(json({ token: 's1.abc', expiresAt: 'x' }))
      .mockResolvedValueOnce(
        json({ ok: true, version: '1', tz: 'UTC', auth: 'session', sessionExpiresAt: 'x' }),
      );
    render(Login);
    await fireEvent.click(await faceBtn());
    expect(getSpy).toHaveBeenCalledWith(opts);
    await waitFor(() => expect(getToken()).toBe('s1.abc'));
    await waitFor(() => expect(window.location.hash).toBe('#/hoy'));
    expect(get(meInfo)).toEqual({
      version: '1',
      tz: 'UTC',
      auth: 'session',
      sessionExpiresAt: 'x',
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/passkeys/login/options');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('cancelado: mensaje tranquilo (status), no alert', async () => {
    mockPasskeys();
    getSpy.mockRejectedValue(new passkeys.PasskeyError('cancelled'));
    fetchMock.mockResolvedValue(json(opts));
    render(Login);
    await fireEvent.click(await faceBtn());
    expect((await screen.findByRole('status')).textContent).toMatch(/cancelado/);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(getToken()).toBeNull();
  });

  it('401: passkey no reconocida', async () => {
    mockPasskeys();
    fetchMock.mockResolvedValueOnce(json(opts)).mockResolvedValueOnce(apiErr(401));
    render(Login);
    await fireEvent.click(await faceBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/no reconocida/);
    expect(getToken()).toBeNull();
  });

  it('429: bloqueo temporal', async () => {
    mockPasskeys();
    fetchMock.mockResolvedValueOnce(json(opts)).mockResolvedValueOnce(apiErr(429, '600'));
    render(Login);
    await fireEvent.click(await faceBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/bloqueado.*10 min/);
  });

  it('sin conexion al iniciar sesion', async () => {
    mockPasskeys();
    fetchMock.mockResolvedValueOnce(json(opts)).mockRejectedValueOnce(new TypeError('down'));
    render(Login);
    await fireEvent.click(await faceBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/conexión/);
  });

  it('opciones caducadas: refresca y pide pulsar de nuevo sin llamar a get', async () => {
    mockPasskeys();
    fetchMock.mockResolvedValue(json(opts));
    const now = vi.spyOn(Date, 'now');
    render(Login);
    const btn = await faceBtn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(Date.now() + 5 * 60 * 1000);
    await fireEvent.click(btn);
    expect((await screen.findByRole('status')).textContent).toMatch(/pulsar|pulsa/);
    expect(getSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe('guard de rutas y logout', () => {
  it('sin token: cualquier ruta redirige a login y no llama a /api/*', async () => {
    window.location.hash = '#/notas';
    render(App);
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
    expect(screen.getByLabelText('Token de acceso')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Navegación principal' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logout en Ajustes borra token y vuelve a login', async () => {
    // Ajustes pide el estado de Google al montarse (con sesion); tras logout no hay mas llamadas.
    fetchMock.mockResolvedValue(
      json({
        configured: true,
        connected: false,
        reason: 'not_connected',
        scopes: [],
        connectedAt: null,
        lastError: null,
      }),
    );
    setToken('t');
    window.location.hash = '#/ajustes';
    render(App);
    expect(screen.getByText('conectado')).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE}/api/google/status`);
    await fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
    expect(getToken()).toBeNull();
    await waitFor(() => expect(screen.getByLabelText('Token de acceso')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
