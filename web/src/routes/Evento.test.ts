import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import Evento from './Evento.svelte';
import Hoy from './Hoy.svelte';
import { clearToken, getToken, setToken } from '../lib/auth';
import { eventHref, getRouteParams, getCurrentRoute } from '../router';

const BASE = 'https://worker.example.workers.dev';
const CAL = { id: 'c@x', name: 'Personal', color: '#1a73e8', visible: true, accessRole: 'owner' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ev(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    calendarId: 'c@x',
    color: '#d93025',
    status: 'confirmed',
    summary: 'Dentista',
    location: 'Calle Mayor 1',
    description: 'Llevar <b>informe</b>',
    allDay: false,
    startAt: '2026-10-24T08:00:00Z',
    endAt: '2026-10-24T09:00:00Z',
    startDate: null,
    endDate: null,
    recurringEventId: null,
    htmlLink: null,
    origin: 'google',
    notes: '',
    remind: false,
    remindDaysBefore: 5,
    writable: true,
    frozen: false,
    pending: null,
    metaScopes: { instance: null, series: null },
    ...over,
  };
}

const vals = (over: Record<string, unknown> = {}) => ({
  notes: null,
  remind: null,
  remindDaysBefore: null,
  color: null,
  ...over,
});

let current: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;
let respond: (method: string, url: URL, body: unknown) => Response | Promise<Response> | null;

beforeEach(() => {
  current = ev();
  respond = () => null;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const custom = respond(method, u, body);
    if (custom) return custom;
    if (u.pathname === '/api/calendars') return json({ calendars: [CAL] });
    if (u.pathname === '/api/today') {
      return json({
        today: '2026-10-24',
        tomorrow: '2026-10-25',
        todayEvents: [current],
        tomorrowEvents: [],
      });
    }
    if (u.pathname.startsWith('/api/agenda/')) return json(current);
    if (u.pathname.startsWith('/api/google') || u.pathname.startsWith('/api/me')) return json({});
    throw new Error(`fetch inesperado: ${u.pathname}`);
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
const putBody = (i = 0) => JSON.parse(String(puts()[i][1].body));
const mount = () => render(Evento, { calendarId: 'c@x', eventId: 'e1' });

describe('Evento: render', () => {
  it('muestra datos de Google como texto plano y separa las notas privadas', async () => {
    current = ev({ origin: 'app', pending: { op: 'patch', error: 'calendar_forbidden' } });
    mount();
    expect(await screen.findByRole('heading', { name: 'Dentista' })).toBeTruthy();
    expect(screen.getByText('Calle Mayor 1')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
    expect(screen.getByText(/10:00 - 11:00/)).toBeTruthy();
    expect(screen.getByText('Descripción (de Google Calendar)')).toBeTruthy();
    expect(screen.getByText('Llevar <b>informe</b>')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Notas privadas (solo en la app)' })).toBeTruthy();
    expect(screen.getByText('Creado en la app')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/calendar_forbidden/);
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/agenda/'))!;
    expect(String(call[0])).toBe(`${BASE}/api/agenda/c%40x/e1`);
  });

  it('dia completo multi-dia', async () => {
    current = ev({
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: '2026-10-24',
      endDate: '2026-10-27',
    });
    mount();
    expect(await screen.findByText(/Del .*24 de octubre.* al .*26 de octubre/)).toBeTruthy();
  });

  it('dias de antelacion solo con avisar', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Dentista' });
    expect(screen.queryByLabelText('Días de antelación')).toBeNull();
    await fireEvent.click(screen.getByLabelText('Avisar'));
    expect((screen.getByLabelText('Días de antelación') as HTMLInputElement).value).toBe('5');
  });
});

describe('Evento: guardar', () => {
  it('solo envia los campos cambiados', async () => {
    current = ev({ notes: 'abc', remind: true });
    mount();
    const area = (await screen.findByLabelText('Notas')) as HTMLTextAreaElement;
    expect(screen.getByRole('button', { name: 'Guardar' }).hasAttribute('disabled')).toBe(true);
    await fireEvent.input(area, { target: { value: 'nueva nota' } });
    respond = (m) => (m === 'PUT' ? json(ev({ notes: 'nueva nota', remind: true })) : null);
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody()).toEqual({ scope: 'instance', notes: 'nueva nota' });
    expect(await screen.findByText('Guardado.')).toBeTruthy();
  });

  it('no recurrente: sin selector de ambito', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Dentista' });
    expect(screen.queryByLabelText('Toda la serie')).toBeNull();
  });

  it('recurrente: elegir serie envia scope series; vaciar la nota envia "" y heredar envia null', async () => {
    current = ev({
      recurringEventId: 'rec1',
      notes: 'de la serie',
      metaScopes: { instance: null, series: vals({ notes: 'de la serie' }) },
    });
    mount();
    const area = (await screen.findByLabelText('Notas')) as HTMLTextAreaElement;
    expect(screen.getByText('Personalizado en la serie')).toBeTruthy();
    // vaciar explicitamente en la instancia -> ""
    await fireEvent.input(area, { target: { value: '' } });
    respond = (m) => (m === 'PUT' ? json(current) : null);
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody()).toEqual({ scope: 'instance', notes: '' });

    // ahora la instancia tiene nota vacia propia; heredar -> null
    current = ev({
      recurringEventId: 'rec1',
      notes: '',
      metaScopes: { instance: vals({ notes: '' }), series: vals({ notes: 'de la serie' }) },
    });
    cleanup();
    mount();
    await screen.findByLabelText('Notas');
    expect(screen.getByText('Personalizado en esta instancia')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: /Heredar de la serie \(nota\)/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(putBody(1)).toEqual({ scope: 'instance', notes: null });
  });

  it('recurrente: toda la serie', async () => {
    current = ev({ recurringEventId: 'rec1' });
    mount();
    await screen.findByLabelText('Notas');
    await fireEvent.click(screen.getByLabelText('Toda la serie'));
    await fireEvent.input(screen.getByLabelText('Notas'), { target: { value: 'x' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody()).toEqual({ scope: 'series', notes: 'x' });
  });

  it('al elegir la serie se muestran los valores de la serie, con aviso de que la instancia manda', async () => {
    current = ev({
      recurringEventId: 'rec1',
      notes: 'A',
      metaScopes: {
        instance: vals({ notes: 'A' }),
        series: vals({ notes: 'B' }),
      },
    });
    mount();
    const area = (await screen.findByLabelText('Notas')) as HTMLTextAreaElement;
    expect(area.value).toBe('A');
    expect(screen.queryByTestId('shadow-warning')).toBeNull();
    await fireEvent.click(screen.getByLabelText('Toda la serie'));
    expect((screen.getByLabelText('Notas') as HTMLTextAreaElement).value).toBe('B');
    expect(screen.getByTestId('shadow-warning').textContent).toMatch(
      /Esta instancia tiene su propia nota, que tiene prioridad sobre la de la serie/,
    );
    await fireEvent.input(screen.getByLabelText('Notas'), { target: { value: 'C' } });
    respond = (m) => (m === 'PUT' ? json(current) : null);
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody()).toEqual({ scope: 'series', notes: 'C' });
  });

  it('cambiar de ambito con cambios sin guardar pide confirmacion y conserva si se cancela', async () => {
    current = ev({
      recurringEventId: 'rec1',
      metaScopes: { instance: null, series: vals({ notes: 'B' }) },
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    await fireEvent.input(await screen.findByLabelText('Notas'), { target: { value: 'mia' } });
    await fireEvent.click(screen.getByLabelText('Toda la serie'));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Notas') as HTMLTextAreaElement).value).toBe('mia');
    expect((screen.getByLabelText('Solo esta instancia') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Toda la serie') as HTMLInputElement).checked).toBe(false);
    confirmSpy.mockReturnValue(true);
    await fireEvent.click(screen.getByLabelText('Toda la serie'));
    expect((screen.getByLabelText('Notas') as HTMLTextAreaElement).value).toBe('B');
    confirmSpy.mockRestore();
  });

  it('vaciar los dias y desmarcar Avisar no deja Guardar bloqueado ni envia dias invalidos', async () => {
    current = ev({ remind: true });
    mount();
    await fireEvent.input(await screen.findByLabelText('Días de antelación'), {
      target: { value: '' },
    });
    expect(screen.getByRole('button', { name: 'Guardar' }).hasAttribute('disabled')).toBe(true);
    await fireEvent.click(screen.getByLabelText('Avisar'));
    const save = screen.getByRole('button', { name: 'Guardar' });
    expect(save.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(save);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody()).toEqual({ scope: 'instance', remind: false });
  });

  it('color: paleta y sin color propio (null)', async () => {
    current = ev({ metaScopes: { instance: vals({ color: '#188038' }), series: null } });
    mount();
    await screen.findByLabelText('Notas');
    await fireEvent.click(screen.getByRole('button', { name: 'Color #d93025' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody()).toEqual({ scope: 'instance', color: '#d93025' });
    await waitFor(() => expect(screen.queryByText('Guardando...')).toBeNull());
    await fireEvent.click(screen.getByRole('button', { name: 'Sin color propio' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(putBody(1)).toEqual({ scope: 'instance', color: null });
  });

  it('dias fuera de rango bloquean guardar', async () => {
    mount();
    await fireEvent.click(await screen.findByLabelText('Avisar'));
    await fireEvent.input(screen.getByLabelText('Días de antelación'), { target: { value: '90' } });
    expect(screen.getByRole('button', { name: 'Guardar' }).hasAttribute('disabled')).toBe(true);
    await fireEvent.input(screen.getByLabelText('Días de antelación'), { target: { value: '7' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody()).toEqual({ scope: 'instance', remind: true, remind_days_before: 7 });
  });

  it('error conserva el formulario y muestra mensaje en espanol', async () => {
    mount();
    const area = (await screen.findByLabelText('Notas')) as HTMLTextAreaElement;
    await fireEvent.input(area, { target: { value: 'mi nota' } });
    respond = (m) => (m === 'PUT' ? json({ error: { code: 'boom', message: 'x' } }, 500) : null);
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/No se pudo guardar.*500/);
    expect((screen.getByLabelText('Notas') as HTMLTextAreaElement).value).toBe('mi nota');
    expect(screen.getByRole('button', { name: 'Guardar' }).hasAttribute('disabled')).toBe(false);
  });

  it('401 al guardar cierra sesion', async () => {
    mount();
    await fireEvent.input(await screen.findByLabelText('Notas'), { target: { value: 'x' } });
    respond = (m) =>
      m === 'PUT' ? json({ error: { code: 'unauthorized', message: 'no' } }, 401) : null;
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(getToken()).toBeNull());
  });
});

describe('Evento: quitar personalizacion', () => {
  it('DELETE con el ambito elegido', async () => {
    current = ev({
      recurringEventId: 'rec1',
      metaScopes: { instance: vals({ notes: 'i' }), series: vals({ notes: 's' }) },
      notes: 'i',
    });
    mount();
    await screen.findByLabelText('Notas');
    await fireEvent.click(screen.getByLabelText('Toda la serie'));
    respond = (m) => (m === 'DELETE' ? json(ev({ recurringEventId: 'rec1' })) : null);
    await fireEvent.click(
      screen.getByRole('button', { name: 'Quitar personalización de la serie' }),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(true),
    );
    const del = fetchMock.mock.calls.find((c) => c[1]?.method === 'DELETE')!;
    expect(String(del[0])).toBe(`${BASE}/api/agenda/c%40x/e1/meta?scope=series`);
    expect(await screen.findByText('Personalización quitada.')).toBeTruthy();
  });

  it('no aparece sin personalizacion', async () => {
    mount();
    await screen.findByLabelText('Notas');
    expect(screen.queryByRole('button', { name: /Quitar personalización/ })).toBeNull();
  });
});

describe('Evento: errores de carga', () => {
  it('404 muestra "El evento ya no existe" y volver', async () => {
    respond = () => json({ error: { code: 'not_found', message: 'x' } }, 404);
    mount();
    expect(await screen.findByText('El evento ya no existe.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Volver' })).toBeTruthy();
  });

  it('401 cierra sesion', async () => {
    respond = (_m, u) =>
      u.pathname.startsWith('/api/agenda/')
        ? json({ error: { code: 'unauthorized', message: 'n' } }, 401)
        : null;
    mount();
    await waitFor(() => expect(getToken()).toBeNull());
  });

  it('descarta la respuesta vieja y no actualiza tras desmontar', async () => {
    let resolve!: (r: Response) => void;
    respond = (_m, u) =>
      u.pathname.startsWith('/api/agenda/') ? new Promise<Response>((r) => (resolve = r)) : null;
    const { unmount } = mount();
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    unmount();
    resolve(json(ev()));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Dentista')).toBeNull();
  });
});

describe('Navegacion', () => {
  it('eventHref codifica ids y getRouteParams los decodifica', () => {
    const h = eventHref('a@b.com', 'x/y');
    expect(h).toBe('#/evento/a%40b.com/x%2Fy');
    expect(getRouteParams(h)).toEqual(['a@b.com', 'x/y']);
    window.location.hash = h;
    expect(getCurrentRoute()).toBe('evento');
  });

  it('un evento de Hoy enlaza a su detalle e indica aviso y notas', async () => {
    current = ev({ remind: true, notes: 'algo' });
    render(Hoy);
    const link = await screen.findByRole('link', { name: /10:00.*Dentista.*Calle Mayor 1/ });
    expect(link.getAttribute('href')).toBe('#/evento/c%40x/e1');
    expect(screen.getByRole('img', { name: 'Con aviso' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Con notas privadas' })).toBeTruthy();
  });

  it('el error pendiente en Hoy no es un alert anidado en el enlace', async () => {
    current = ev({ pending: { op: 'patch', error: 'boom' } });
    render(Hoy);
    const link = await screen.findByRole('link', { name: /Dentista.*boom/ });
    expect(link.querySelector('[role="alert"]')).toBeNull();
  });
});
