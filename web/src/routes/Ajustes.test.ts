import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import Ajustes from './Ajustes.svelte';
import { clearToken, setToken } from '../lib/auth';
import { nav } from '../lib/google';

type Init = NonNullable<Parameters<typeof fetch>[1]>;

const BASE = 'https://worker.example.workers.dev';
const EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const CALLIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const disconnected = (reason = 'not_connected', configured = true) => ({
  configured,
  connected: false,
  reason,
  scopes: [],
  connectedAt: null,
  lastError: reason === 'not_connected' ? null : reason,
});
const connected = {
  configured: true,
  connected: true,
  reason: null,
  scopes: [EVENTS, CALLIST],
  connectedAt: '2026-10-22T08:00:00.000Z',
  lastError: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
let goSpy: ReturnType<typeof vi.spyOn>;
let routes: Record<string, () => Response>;

function urlOf(call: unknown[]): string {
  return String(call[0]);
}

beforeEach(() => {
  routes = { 'GET /api/google/status': () => json(disconnected()) };
  fetchMock = vi.fn(async (url: string, init?: Init) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`fetch inesperado: ${key}`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_BASE', BASE);
  goSpy = vi.spyOn(nav, 'go').mockImplementation(() => {});
  setToken('tok-123');
  window.location.hash = '#/ajustes';
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearToken();
});

describe('Ajustes: seccion Google', () => {
  it('muestra desconectado y boton Conectar; status con Bearer', async () => {
    render(Ajustes);
    expect(await screen.findByRole('button', { name: 'Conectar Google' })).toBeTruthy();
    expect(screen.getByText(/no está conectado/)).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0] as [string, Init];
    expect(url).toBe(`${BASE}/api/google/status`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('muestra conectado con permisos y boton Desconectar', async () => {
    routes['GET /api/google/status'] = () => json(connected);
    render(Ajustes);
    expect(await screen.findByText('Conectado')).toBeTruthy();
    expect(screen.getByText('Ver y editar eventos')).toBeTruthy();
    expect(screen.getByText('Ver la lista de calendarios')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Desconectar Google' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Conectar Google' })).toBeNull();
  });

  it('invalid_grant: explica que hay que reconectar', async () => {
    routes['GET /api/google/status'] = () => json(disconnected('invalid_grant'));
    render(Ajustes);
    expect(await screen.findByText(/revocado o caducado/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conectar Google' })).toBeTruthy();
  });

  it('servidor sin configurar: no ofrece conectar', async () => {
    routes['GET /api/google/status'] = () => json(disconnected('not_connected', false));
    render(Ajustes);
    expect(await screen.findByText(/todavía no tiene configurada/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Conectar Google' })).toBeNull();
  });

  it('error al pedir el estado: alerta y reintentar', async () => {
    routes['GET /api/google/status'] = () => json({ error: { code: 'x', message: 'x' } }, 500);
    render(Ajustes);
    expect((await screen.findByRole('alert')).textContent).toMatch(/estado de Google/);
    routes['GET /api/google/status'] = () => json(connected);
    await fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Conectado')).toBeTruthy();
  });

  it('Conectar: pide ticket con Bearer y navega a /oauth/google/start en la base del API', async () => {
    routes['POST /api/oauth/google/ticket'] = () =>
      json({ ticket: 'v1.abc_DEF-123.1700000000000.sig_-x', expiresIn: 60 });
    render(Ajustes);
    await fireEvent.click(await screen.findByRole('button', { name: 'Conectar Google' }));
    await waitFor(() => expect(goSpy).toHaveBeenCalledTimes(1));
    expect(goSpy).toHaveBeenCalledWith(
      `${BASE}/oauth/google/start?ticket=v1.abc_DEF-123.1700000000000.sig_-x`,
    );
    const ticketCall = fetchMock.mock.calls.find((c) => urlOf(c).endsWith('/ticket'))!;
    expect((ticketCall[1] as Init).method).toBe('POST');
    expect(((ticketCall[1] as Init).headers as Record<string, string>).Authorization).toBe(
      'Bearer tok-123',
    );
    // El token de la app nunca va en la URL de navegacion.
    expect(String(goSpy.mock.calls[0]![0])).not.toContain('tok-123');
  });

  it('Conectar con servidor sin configurar (500 misconfigured): mensaje y no navega', async () => {
    routes['POST /api/oauth/google/ticket'] = () =>
      json({ error: { code: 'misconfigured', message: 'x' } }, 500);
    render(Ajustes);
    await fireEvent.click(await screen.findByRole('button', { name: 'Conectar Google' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/todavía no tiene configurada/);
    expect(goSpy).not.toHaveBeenCalled();
  });

  it('Conectar con ticket mal formado: no navega', async () => {
    routes['POST /api/oauth/google/ticket'] = () =>
      json({ ticket: 'https://evil.example/?x', expiresIn: 60 });
    render(Ajustes);
    await fireEvent.click(await screen.findByRole('button', { name: 'Conectar Google' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(goSpy).not.toHaveBeenCalled();
  });

  it('Conectar sin VITE_API_BASE: fail-closed, ninguna peticion ni navegacion', async () => {
    render(Ajustes);
    await screen.findByRole('button', { name: 'Conectar Google' });
    vi.stubEnv('VITE_API_BASE', '');
    fetchMock.mockClear();
    await fireEvent.click(screen.getByRole('button', { name: 'Conectar Google' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/no está configurada/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(goSpy).not.toHaveBeenCalled();
  });

  it('vuelta con ?google=ok: mensaje de exito y URL limpia antes de pedir el estado', async () => {
    window.location.hash = '#/ajustes?google=ok';
    let hashAtFetch = '';
    routes['GET /api/google/status'] = () => {
      hashAtFetch = window.location.hash;
      return json(connected);
    };
    render(Ajustes);
    expect((await screen.findByText('Google conectado.')).getAttribute('role')).toBe('status');
    expect(window.location.hash).toBe('#/ajustes');
    await waitFor(() => expect(hashAtFetch).toBe('#/ajustes'));
  });

  it('?google=ok forjado con estado real desconectado: mensaje neutro, sin "Google conectado."', async () => {
    window.location.hash = '#/ajustes?google=ok';
    render(Ajustes);
    expect(await screen.findByText(/Comprueba el estado de la conexión/)).toBeTruthy();
    expect(screen.queryByText('Google conectado.')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Conectar Google' })).toBeTruthy();
  });

  it('?google=ok con fallo al pedir el estado: mensaje neutro', async () => {
    window.location.hash = '#/ajustes?google=ok';
    routes['GET /api/google/status'] = () => json({ error: { code: 'x', message: 'x' } }, 500);
    render(Ajustes);
    expect(await screen.findByText(/Comprueba el estado de la conexión/)).toBeTruthy();
    expect(screen.queryByText('Google conectado.')).toBeNull();
  });

  it('Conectar: tras navegar con exito el boton sigue deshabilitado (no hay segundo ticket)', async () => {
    routes['POST /api/oauth/google/ticket'] = () =>
      json({ ticket: 'v1.abc_DEF-123.1700000000000.sig_-x', expiresIn: 60 });
    render(Ajustes);
    const btn = await screen.findByRole('button', { name: 'Conectar Google' });
    await fireEvent.click(btn);
    await waitFor(() => expect(goSpy).toHaveBeenCalledTimes(1));
    const after = screen.getByRole('button', { name: /Abriendo Google/ }) as HTMLButtonElement;
    expect(after.disabled).toBe(true);
    const tickets = fetchMock.mock.calls.filter((c) => urlOf(c).endsWith('/ticket'));
    expect(tickets).toHaveLength(1);
    expect(goSpy).toHaveBeenCalledTimes(1);
  });

  it('Conectar con error: el boton se reactiva', async () => {
    routes['POST /api/oauth/google/ticket'] = () =>
      json({ error: { code: 'misconfigured', message: 'x' } }, 500);
    render(Ajustes);
    await fireEvent.click(await screen.findByRole('button', { name: 'Conectar Google' }));
    await screen.findByRole('alert');
    const btn = screen.getByRole('button', { name: 'Conectar Google' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('muestra el aviso para iOS standalone junto a Conectar', async () => {
    render(Ajustes);
    await screen.findByRole('button', { name: 'Conectar Google' });
    expect(
      screen.getByText(/abre la app desde el icono; la conexión se guarda igualmente/),
    ).toBeTruthy();
  });

  it('credenciales ilegibles (unreadable): pide reconectar', async () => {
    routes['GET /api/google/status'] = () => json(disconnected('unreadable'));
    render(Ajustes);
    expect(await screen.findByText(/No se pueden leer las credenciales/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conectar Google' })).toBeTruthy();
  });

  it('vuelta con ?google=error&reason=missing_scope: alerta especifica', async () => {
    window.location.hash = '#/ajustes?google=error&reason=missing_scope';
    render(Ajustes);
    expect((await screen.findByRole('alert')).textContent).toMatch(/permiso para ver y editar/);
    expect(window.location.hash).toBe('#/ajustes');
  });

  it('vuelta con ?google=error&reason=extra_scope: avisa de la revocacion', async () => {
    window.location.hash = '#/ajustes?google=error&reason=extra_scope';
    render(Ajustes);
    expect((await screen.findByRole('alert')).textContent).toMatch(/revocado/);
  });

  it('reason desconocido o inyectado: mensaje generico, sin reflejar el valor', async () => {
    window.location.hash = '#/ajustes?google=error&reason=%3Cimg%20src%3Dx%3E';
    render(Ajustes);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Error inesperado/);
    expect(alert.innerHTML).not.toContain('<img');
    expect(window.location.href).not.toContain('reason');
  });

  it('Desconectar: confirma, llama a disconnect y recarga el estado', async () => {
    routes['GET /api/google/status'] = () => json(connected);
    routes['POST /api/google/disconnect'] = () => json({ ok: true, revoked: true });
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    render(Ajustes);
    await fireEvent.click(await screen.findByRole('button', { name: 'Desconectar Google' }));
    routes['GET /api/google/status'] = () => json(disconnected());
    expect(await screen.findByText('Google desconectado.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Conectar Google' })).toBeTruthy();
    expect(fetchMock.mock.calls.some((c) => urlOf(c).endsWith('/api/google/disconnect'))).toBe(
      true,
    );
  });

  it('Desconectar cancelado: no llama a la API', async () => {
    routes['GET /api/google/status'] = () => json(connected);
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    render(Ajustes);
    await fireEvent.click(await screen.findByRole('button', { name: 'Desconectar Google' }));
    expect(fetchMock.mock.calls.some((c) => urlOf(c).includes('disconnect'))).toBe(false);
  });

  it('Desconectar sin revocacion confirmada: avisa', async () => {
    routes['GET /api/google/status'] = () => json(connected);
    routes['POST /api/google/disconnect'] = () => json({ ok: true, revoked: false });
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    render(Ajustes);
    await fireEvent.click(await screen.findByRole('button', { name: 'Desconectar Google' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/no se pudo confirmar/);
  });
});
