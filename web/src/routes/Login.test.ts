import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
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
