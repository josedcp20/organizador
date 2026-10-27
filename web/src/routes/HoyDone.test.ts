import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import Hoy from './Hoy.svelte';
import { clearToken, setToken } from '../lib/auth';

const BASE = 'https://worker.example.workers.dev';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const event = (id: string, summary: string, done = false) => ({
  id,
  calendarId: 'c',
  color: '#d93025',
  status: 'confirmed',
  summary,
  location: null,
  allDay: false,
  startAt: '2026-10-23T08:30:00.000Z',
  endAt: null,
  origin: 'google',
  pending: null,
  done,
});

let putStatus: number;
let initialDone: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  putStatus = 200;
  initialDone = false;
  fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const u = new URL(url);
    if (u.pathname === '/api/today') {
      return json({
        today: '2026-10-23',
        tomorrow: '2026-10-24',
        todayEvents: [event('e1', 'Dentista', initialDone), event('e2', 'Banco')],
        tomorrowEvents: [],
      });
    }
    if (init?.method === 'PUT') return json(event('e1', 'Dentista', true), putStatus);
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_BASE', BASE);
  setToken('tok');
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearToken();
  window.location.hash = '';
});

const puts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');

describe('Hoy: hecho', () => {
  it('marca con PUT {done:true}, no navega y conserva el orden', async () => {
    render(Hoy);
    const btn = await screen.findByRole('button', { name: 'Hecho: Dentista' });
    await fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute('aria-pressed')).toBe('true'));
    expect(puts()).toHaveLength(1);
    expect(String(puts()[0][0])).toBe(`${BASE}/api/agenda/c/e1/done`);
    expect(JSON.parse(String(puts()[0][1].body))).toEqual({ done: true });
    expect(window.location.hash).toBe('');
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toMatch(/Dentista/);
    expect(items[1]).toMatch(/Banco/);
  });

  it('revierte y avisa si el PUT falla', async () => {
    putStatus = 500;
    render(Hoy);
    const btn = await screen.findByRole('button', { name: 'Hecho: Dentista' });
    await fireEvent.click(btn);
    expect((await screen.findByRole('alert')).textContent).toMatch(/No se pudo marcar el evento/);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('muestra los hechos ya marcados', async () => {
    initialDone = true;
    render(Hoy);
    const btn = await screen.findByRole('button', { name: 'Hecho: Dentista' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});
