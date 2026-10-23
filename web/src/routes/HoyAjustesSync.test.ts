import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import Hoy from './Hoy.svelte';
import Ajustes from './Ajustes.svelte';
import { clearToken, setToken } from '../lib/auth';

const BASE = 'https://worker.example.workers.dev';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const status = (connected: boolean) => ({
  configured: true,
  connected,
  reason: connected ? null : 'not_connected',
  scopes: [],
  connectedAt: null,
  lastError: null,
});
const cal = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  color: '#1a73e8',
  visible: true,
  accessRole: 'owner',
  writable: true,
  lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastSyncError: null,
  ...over,
});

let routes: Record<string, () => Response>;

beforeEach(() => {
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
      const h = routes[key];
      if (!h) throw new Error(`fetch inesperado: ${key}`);
      return h();
    }),
  );
  vi.stubEnv('VITE_API_BASE', BASE);
  setToken('tok-123');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearToken();
});

describe('Hoy', () => {
  const today = {
    today: '2026-10-23',
    tomorrow: '2026-10-24',
    todayEvents: [
      {
        id: 'e1',
        calendarId: 'c',
        color: '#d93025',
        status: 'confirmed',
        summary: 'Dentista',
        location: 'Clinica',
        allDay: false,
        startAt: '2026-10-23T08:30:00.000Z',
        endAt: null,
        origin: 'app',
        pending: { op: 'insert', error: 'fallo' },
      },
    ],
    tomorrowEvents: [],
  };

  it('muestra eventos, vacio y banners', async () => {
    routes['GET /api/today'] = () => json(today);
    routes['GET /api/google/status'] = () => json(status(false));
    routes['GET /api/calendars'] = () =>
      json({ calendars: [cal('a', 'Personal', { lastSyncError: 'x' })] });
    render(Hoy);
    expect(await screen.findByText('Dentista')).toBeTruthy();
    expect(screen.getByText('10:30')).toBeTruthy();
    expect(screen.getByText('Clinica')).toBeTruthy();
    expect(screen.getByText('Nada mañana')).toBeTruthy();
    expect(screen.getByText(/No se pudo enviar a Google: fallo/)).toBeTruthy();
    expect(screen.getByLabelText('Pendiente de sincronizar')).toBeTruthy();
    expect(screen.getByText(/Google no está conectado/)).toBeTruthy();
    expect(screen.getByText(/Error de sincronización en: Personal/)).toBeTruthy();
  });

  it('visibilitychange recarga y se quita el listener al desmontar', async () => {
    routes['GET /api/today'] = () => json({ ...today, todayEvents: [] });
    routes['GET /api/google/status'] = () => json(status(true));
    routes['GET /api/calendars'] = () => json({ calendars: [] });
    const count = () =>
      (vi.mocked(fetch).mock.calls as unknown[][]).filter((c) =>
        String(c[0]).includes('/api/today'),
      ).length;
    const { unmount } = render(Hoy);
    await screen.findByText('Nada hoy');
    expect(count()).toBe(1);
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(count()).toBe(2));
    unmount();
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 20));
    expect(count()).toBe(2);
  });

  it('error de carga', async () => {
    routes['GET /api/today'] = () => json({ error: { code: 'x', message: 'x' } }, 500);
    routes['GET /api/google/status'] = () => json(status(true));
    routes['GET /api/calendars'] = () => json({ calendars: [] });
    render(Hoy);
    expect((await screen.findByText(/No se pudieron cargar/)).textContent).toBeTruthy();
  });
});

describe('Ajustes: sync', () => {
  beforeEach(() => {
    routes['GET /api/google/status'] = () => json(status(true));
    routes['GET /api/calendars'] = () =>
      json({
        calendars: [
          cal('a', 'Personal'),
          cal('b', 'Compartido', { writable: false, accessRole: 'reader', lastSyncError: 'boom' }),
        ],
      });
  });

  it('muestra ultima sync, error, solo lectura y colores duplicados', async () => {
    render(Ajustes);
    expect(await screen.findAllByText(/Última sync: hace 5 min/)).toHaveLength(2);
    expect(screen.getByText('solo lectura')).toBeTruthy();
    expect(screen.getByText(/Error de sincronización: boom/)).toBeTruthy();
    expect(screen.getByText(/comparten el mismo color: Personal, Compartido/)).toBeTruthy();
  });

  it('Sincronizar ahora: 429 con mensaje amable', async () => {
    routes['POST /api/sync'] = () => json({ error: { code: 'rate_limited', message: 'x' } }, 429);
    render(Ajustes);
    await fireEvent.click(await screen.findByRole('button', { name: 'Sincronizar ahora' }));
    expect(await screen.findByText(/Espera un minuto/)).toBeTruthy();
  });

  it('Sincronizar ahora: ok refresca', async () => {
    routes['POST /api/sync'] = () => json({ status: 'ok' });
    render(Ajustes);
    await fireEvent.click(await screen.findByRole('button', { name: 'Sincronizar ahora' }));
    expect(await screen.findByText('Sincronización completada.')).toBeTruthy();
  });

  it('Sincronizar ahora: con fallos avisa y bloquea controles mientras sincroniza', async () => {
    let release!: (r: Response) => void;
    routes['POST /api/sync'] = () => new Promise<Response>((res) => (release = res)) as never;
    render(Ajustes);
    // Espera a que la lista de calendarios cargue antes de pulsar (evita carrera en CI).
    await screen.findByRole('switch', { name: 'Mostrar Personal' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Sincronizar ahora' }));
    const sw = screen.getByRole('switch', { name: 'Mostrar Personal' }) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(
      (screen.getByLabelText('Color personalizado para Personal') as HTMLInputElement).disabled,
    ).toBe(true);
    release(json({ status: 'ok', failed: 1, partial: 0 }));
    expect(await screen.findByText('Sincronización completada con errores.')).toBeTruthy();
    expect(sw.disabled).toBe(false);
  });
});
