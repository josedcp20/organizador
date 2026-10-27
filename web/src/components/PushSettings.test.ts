import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { PushStatusResponse } from '@organizador/shared';
import PushSettings from './PushSettings.svelte';
import { clearToken, setToken } from '../lib/auth';
import { PUSH_ENABLED_KEY } from '../lib/push';
import { fakeSub, installPushBrowser, PUBLIC_KEY, uninstallPushBrowser } from '../lib/pushTestEnv';

type Init = NonNullable<Parameters<typeof fetch>[1]>;
const BASE = 'https://worker.example.workers.dev';
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const DEVICE = {
  id: '0123456789abcdef',
  label: 'iPhone/Mac (Apple)',
  createdAt: '2026-10-26T08:00:00.000Z',
  lastOkAt: null,
  failCount: 2,
  lastError: 'rejected_403',
};
let status: PushStatusResponse;
let routes: Record<string, () => Response>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  status = {
    configured: true,
    publicKey: PUBLIC_KEY,
    subject: 's',
    subscriptions: [],
    digest: null,
  };
  routes = {
    'GET /api/push/status': () => json(status),
    'POST /api/push/subscribe': () => json({ id: DEVICE.id }),
    'DELETE /api/push/subscribe': () => new Response(null, { status: 204 }),
    'POST /api/push/test': () => json({ sent: 1, failed: 0, removed: 0 }),
  };
  fetchMock = vi.fn(async (url: string, init?: Init) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
    const h = routes[key];
    if (!h) throw new Error(`fetch inesperado ${key}`);
    return h();
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_BASE', BASE);
  setToken('tok-1');
});

afterEach(() => {
  cleanup();
  uninstallPushBrowser();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearToken();
  localStorage.removeItem(PUSH_ENABLED_KEY);
  localStorage.removeItem('organizador_push_id');
});

const calls = (key: string) =>
  fetchMock.mock.calls.filter(
    (c) =>
      `${(c[1] as Init | undefined)?.method ?? 'GET'} ${new URL(String(c[0])).pathname}` === key,
  );

describe('PushSettings', () => {
  it('navegador sin soporte: aviso y ninguna peticion', () => {
    render(PushSettings);
    expect(screen.getByText(/no admite notificaciones push/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('iPhone sin instalar: instrucciones de pantalla de inicio', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5)',
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    render(PushSettings);
    expect(screen.getByText(/Añadir a pantalla de inicio/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('servidor sin VAPID: lo indica y no ofrece activar', async () => {
    installPushBrowser();
    status = { ...status, configured: false, publicKey: null };
    render(PushSettings);
    expect(await screen.findByText(/no tiene configuradas/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activar notificaciones' })).toBeNull();
  });

  it('permiso denegado: explica como reactivarlo', async () => {
    installPushBrowser({ permission: 'denied' });
    render(PushSettings);
    expect(await screen.findByText(/están bloqueadas/)).toBeTruthy();
  });

  it('activar: deshabilitado hasta precargar; requestPermission + subscribe + POST', async () => {
    const b = installPushBrowser();
    render(PushSettings);
    const btn = screen.getByRole('button', { name: 'Activar notificaciones' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await waitFor(() => expect(btn.disabled).toBe(false));
    await fireEvent.click(btn);
    expect(b.requestPermission).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Notificaciones activadas en este dispositivo.')).toBeTruthy();
    expect(b.pushManager.subscribe).toHaveBeenCalled();
    expect(calls('POST /api/push/subscribe')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Enviar prueba' })).toBeTruthy();
  });

  it('activado: prueba, 429 y desactivar', async () => {
    installPushBrowser({ permission: 'granted', current: fakeSub('https://web.push.apple.com/X') });
    localStorage.setItem(PUSH_ENABLED_KEY, '1');
    render(PushSettings);
    await fireEvent.click(await screen.findByRole('button', { name: 'Enviar prueba' }));
    expect(await screen.findByText('Prueba enviada a 1 dispositivo.')).toBeTruthy();
    routes['POST /api/push/test'] = () =>
      json({ error: { code: 'rate_limited', message: 'x' } }, 429, { 'Retry-After': '30' });
    await fireEvent.click(screen.getByRole('button', { name: 'Enviar prueba' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Espera 30 s/);
    await fireEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
    expect(
      await screen.findByText('Notificaciones desactivadas en este dispositivo.'),
    ).toBeTruthy();
    expect(calls('DELETE /api/push/subscribe')).toHaveLength(1);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Activar notificaciones' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it('lista de dispositivos con fallos y Quitar por id', async () => {
    installPushBrowser();
    status = { ...status, subscriptions: [DEVICE] };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(PushSettings);
    expect(await screen.findByText(/Fallos: 2 \(rejected_403\)/)).toBeTruthy();
    status = { ...status, subscriptions: [] };
    await fireEvent.click(screen.getByRole('button', { name: `Quitar ${DEVICE.label}` }));
    await waitFor(() => expect(screen.queryByText(DEVICE.label)).toBeNull());
    const del = calls('DELETE /api/push/subscribe')[0]!;
    expect(new URL(String(del[0])).search).toBe(`?id=${DEVICE.id}`);
  });

  it('Quitar en ESTE dispositivo hace la desactivacion completa', async () => {
    const cur = fakeSub('https://web.push.apple.com/X');
    installPushBrowser({ permission: 'granted', current: cur });
    localStorage.setItem(PUSH_ENABLED_KEY, '1');
    localStorage.setItem('organizador_push_id', DEVICE.id);
    status = { ...status, subscriptions: [DEVICE] };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(PushSettings);
    expect(await screen.findByText(/Este dispositivo/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: `Quitar ${DEVICE.label}` }));
    await waitFor(() => expect(cur.unsubscribe).toHaveBeenCalled());
    expect(localStorage.getItem(PUSH_ENABLED_KEY)).toBeNull();
    expect(localStorage.getItem('organizador_push_id')).toBeNull();
    const del = calls('DELETE /api/push/subscribe')[0]!;
    expect(JSON.parse(String((del[1] as Init).body))).toEqual({ endpoint: cur.endpoint });
  });

  it('activar guarda el id devuelto por el servidor', async () => {
    installPushBrowser();
    render(PushSettings);
    const btn = screen.getByRole('button', { name: 'Activar notificaciones' }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    await fireEvent.click(btn);
    await screen.findByText('Notificaciones activadas en este dispositivo.');
    expect(localStorage.getItem('organizador_push_id')).toBe(DEVICE.id);
  });
});
