import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import Calendario from './Calendario.svelte';
import { clearToken, getToken, setToken } from '../lib/auth';
import { todayMadrid } from '../lib/events';

const BASE = 'https://worker.example.workers.dev';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CAL = {
  id: 'c1',
  name: 'Personal',
  color: '#1a73e8',
  visible: true,
  accessRole: 'owner',
  writable: true,
};

function event(over: Record<string, unknown> = {}) {
  const day = todayMadrid();
  return {
    id: 'e1',
    calendarId: 'c1',
    color: '#d93025',
    status: 'confirmed',
    summary: 'Dentista',
    location: null,
    description: null,
    allDay: true,
    startAt: null,
    endAt: null,
    startDate: day,
    endDate: day,
    recurringEventId: null,
    htmlLink: null,
    origin: 'google',
    notes: '',
    remind: false,
    remindDaysBefore: 5,
    writable: true,
    frozen: false,
    pending: null,
    ...over,
  };
}

let events: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  events = () =>
    json({
      from: '',
      to: '',
      events: [event(), event({ id: 'e2', summary: 'Mio', origin: 'app' })],
    });
  fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/calendars') return json({ calendars: [CAL] });
    if (path === '/api/agenda') return events();
    throw new Error(`fetch inesperado: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_BASE', BASE);
  setToken('tok');
  // jsdom: innerWidth 1024 -> vista mes; forzamos agenda pulsando la pestana
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearToken();
});

describe('Calendario', () => {
  it('carga el rango con Bearer y pinta eventos en agenda; app con marca', async () => {
    render(Calendario);
    await fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }));
    expect(await screen.findByText('Dentista')).toBeTruthy();
    expect(screen.getByText('Mio')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Creado en la app' })).toBeTruthy();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/agenda'))!;
    expect(String(call[0])).toMatch(/\/api\/agenda\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  });

  it('filtro "Creados en la app" oculta eventos de la app', async () => {
    render(Calendario);
    await fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }));
    await screen.findByText('Mio');
    await fireEvent.click(screen.getByRole('button', { name: /Creados en la app/ }));
    expect(screen.queryByText('Mio')).toBeNull();
    expect(screen.getByText('Dentista')).toBeTruthy();
  });

  it('filtro por calendario y chip con su nombre', async () => {
    render(Calendario);
    await fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }));
    const chip = await screen.findByRole('button', { name: 'Personal' });
    await fireEvent.click(chip);
    await waitFor(() => expect(screen.queryByText('Dentista')).toBeNull());
  });

  it('pending con error muestra aviso', async () => {
    events = () =>
      json({
        from: '',
        to: '',
        events: [event({ pending: { op: 'patch', error: 'calendar_forbidden' } })],
      });
    render(Calendario);
    await fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('estado vacio y error con reintento', async () => {
    events = () => json({ from: '', to: '', events: [] });
    render(Calendario);
    await fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }));
    expect(await screen.findByText('No hay eventos en este periodo.')).toBeTruthy();
  });

  it('error de API muestra mensaje y boton reintentar', async () => {
    events = () => json({ error: { code: 'boom', message: 'Fallo del servidor' } }, 500);
    render(Calendario);
    expect(await screen.findByText(/Error del servidor \(500\)/)).toBeTruthy();
    expect(screen.queryByText('Fallo del servidor')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
  });

  it('401 cierra sesion', async () => {
    events = () => json({ error: { code: 'unauthorized', message: 'no' } }, 401);
    render(Calendario);
    await waitFor(() => expect(getToken()).toBeNull());
  });

  it('descarta la respuesta vieja al cambiar de vista', async () => {
    const pending: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/api/calendars') return json({ calendars: [CAL] });
      if (path === '/api/agenda') return new Promise<Response>((res) => pending.push(res));
      throw new Error(`fetch inesperado: ${path}`);
    });
    render(Calendario);
    await waitFor(() => expect(pending).toHaveLength(1));
    await fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    const body = (title: string) =>
      json({ from: '', to: '', events: [event({ id: title, summary: title })] });
    pending[1](body('Nuevo'));
    expect(await screen.findByText('Nuevo')).toBeTruthy();
    pending[0](body('Viejo'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Viejo')).toBeNull();
    expect(screen.getByText('Nuevo')).toBeTruthy();
  });

  it('visibilitychange recarga el rango y se quita el listener al desmontar', async () => {
    const count = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/agenda')).length;
    const { unmount } = render(Calendario);
    await waitFor(() => expect(count()).toBe(1));
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(count()).toBe(2));
    unmount();
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 20));
    expect(count()).toBe(2);
  });

  it('una carga fallida por red hace UNA peticion (sin bucle); Reintentar hace otra', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/api/calendars') return json({ calendars: [CAL] });
      if (path === '/api/agenda') throw new TypeError('Failed to fetch');
      throw new Error(`fetch inesperado: ${path}`);
    });
    const count = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/agenda')).length;
    render(Calendario);
    const retry = await screen.findByRole('button', { name: 'Reintentar' });
    await new Promise((r) => setTimeout(r, 300));
    expect(count()).toBe(1);
    await fireEvent.click(retry);
    await screen.findByRole('button', { name: 'Reintentar' });
    await new Promise((r) => setTimeout(r, 300));
    expect(count()).toBe(2);
  });
});
