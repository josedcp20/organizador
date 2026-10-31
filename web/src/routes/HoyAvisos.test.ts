import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import Hoy from './Hoy.svelte';
import { clearToken, setToken } from '../lib/auth';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let today: Record<string, unknown>;
let ackStatus: number;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ackStatus = 200;
  today = { today: '2026-10-23', tomorrow: '2026-10-24', todayEvents: [], tomorrowEvents: [] };
  fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const u = new URL(url);
    if (u.pathname === '/api/today') return json(today);
    if (u.pathname === '/api/digest/ack' && init?.method === 'POST') {
      return ackStatus === 200
        ? json({ ok: true })
        : json({ error: { code: 'x', message: 'x' } }, ackStatus);
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_BASE', 'https://worker.example.workers.dev');
  setToken('tok');
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearToken();
});

const acks = () => fetchMock.mock.calls.filter((c) => new URL(c[0]).pathname === '/api/digest/ack');

describe('Hoy: avisos y banner del resumen', () => {
  it('respuesta antigua sin reminders/digestAlert: no muestra nada', async () => {
    render(Hoy);
    expect(await screen.findByText('Nada hoy')).toBeTruthy();
    expect(screen.queryByText('Cerrar')).toBeNull();
    expect(screen.queryByText(/En \d+ d/)).toBeNull();
  });

  it('lista los avisos con enlace al evento', async () => {
    today.reminders = [
      { calendarId: 'c', id: 'e9', summary: 'Pasaporte', date: '2026-10-25', inDays: 2 },
      { calendarId: 'c', id: 'e8', summary: 'Seguro', date: '2026-10-24', inDays: 1 },
    ];
    render(Hoy);
    const link = (await screen.findByRole('link', { name: 'Pasaporte' })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toMatch(/e9/);
    expect(link.parentElement!.textContent).toMatch(/En 2 días:\s*Pasaporte/);
    expect(screen.getByText(/En 1 día:/)).toBeTruthy();
  });

  it('banner: Cerrar hace POST /api/digest/ack y desaparece', async () => {
    today.digestAlert = { date: '2026-10-23', status: 'failed', lastError: 'rejected_403' };
    render(Hoy);
    const btn = await screen.findByRole('button', { name: 'Cerrar' });
    expect(screen.getByText(/No se pudo enviar el resumen de hoy/)).toBeTruthy();
    await fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cerrar' })).toBeNull());
    expect(acks()).toHaveLength(1);
  });

  it('si el ack falla, el banner reaparece', async () => {
    ackStatus = 500;
    today.digestAlert = { date: '2026-10-23', status: 'gave_up', lastError: null };
    render(Hoy);
    await fireEvent.click(await screen.findByRole('button', { name: 'Cerrar' }));
    await waitFor(() => expect(acks()).toHaveLength(1));
    expect(await screen.findByRole('button', { name: 'Cerrar' })).toBeTruthy();
  });
});
