import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import EventoEditar from './EventoEditar.svelte';
import { clearToken, setToken } from '../lib/auth';

const BASE = 'https://worker.example.workers.dev';
const cal = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Cal ${id}`,
  color: '#1a73e8',
  visible: true,
  accessRole: 'owner',
  writable: true,
  lastSyncedAt: null,
  lastSyncError: null,
  ...over,
});
const CALS = [
  cal('a'),
  cal('ro', { writable: false, accessRole: 'reader' }),
  cal('hidden', { visible: false }),
  cal('b'),
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
const err = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json({ error: { code, message: code }, ...extra }, status);

function ev(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    calendarId: 'a',
    color: '#d93025',
    status: 'confirmed',
    summary: 'Dentista',
    location: 'Calle Mayor 1',
    description: null,
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

let current: Record<string, unknown>;
let settings: Record<string, unknown>;
let connected: boolean;
let fetchMock: ReturnType<typeof vi.fn>;
/** Respuesta a las escrituras (POST/PATCH); por defecto 201 con el evento. */
let write: (method: string, body: unknown, n: number) => Response | Promise<Response>;

beforeEach(() => {
  current = ev();
  settings = { app_events_color: null, default_write_calendar: 'b' };
  connected = true;
  write = (_m, body) =>
    json({ ...ev({ id: 'new1', calendarId: 'b', origin: 'app' }), ...(body as object) }, 201);
  let n = 0;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') return write(method, body, n++);
    if (u.pathname === '/api/calendars') return json({ calendars: CALS });
    if (u.pathname === '/api/settings') return json(settings);
    if (u.pathname === '/api/google/status') return json({ connected });
    if (u.pathname.startsWith('/api/agenda/')) return json(current);
    throw new Error(`fetch inesperado: ${u.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_BASE', BASE);
  setToken('tok');
  window.location.hash = '#/nuevo-evento';
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearToken();
  window.location.hash = '';
});

const writes = (method: string) => fetchMock.mock.calls.filter((c) => c[1]?.method === method);
const bodyOf = (method: string, i = 0) => JSON.parse(String(writes(method)[i][1].body));
const input = (label: string | RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const saveBtn = () =>
  screen.getByRole('button', { name: /Guardar|Guardando/ }) as HTMLButtonElement;
function openDialog() {
  const d = document.querySelector('dialog[open]') as HTMLElement | null;
  if (!d) throw new Error('no hay dialogo abierto');
  return within(d);
}
const noDialog = () => expect(document.querySelector('dialog[open]')).toBeNull();

async function mountCreate(date: string | null = '2026-11-02') {
  render(EventoEditar, { date });
  return (await screen.findByLabelText('Título')) as HTMLInputElement;
}
async function mountEdit() {
  render(EventoEditar, { calendarId: 'a', eventId: 'e1' });
  await screen.findByRole('heading', { name: 'Editar evento' });
  await waitFor(() => expect(screen.queryByText('Cargando...')).toBeNull());
}
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

describe('EventoEditar: alta', () => {
  it('lista solo calendarios writable y visibles, con el por defecto preseleccionado', async () => {
    await mountCreate();
    const sel = screen.getByLabelText('Calendario') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['a', 'b']);
    expect(sel.value).toBe('b');
    expect(screen.queryByText(/notas|avisos|color/i)).toBeNull();
    expect(input('Fecha de inicio').value).toBe('2026-11-02');
  });

  it('default_write_calendar no valido -> el primero', async () => {
    settings = { app_events_color: null, default_write_calendar: 'ro' };
    await mountCreate();
    expect((screen.getByLabelText('Calendario') as HTMLSelectElement).value).toBe('a');
  });

  it('POST con exactamente las claves permitidas y navega al detalle', async () => {
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: '  Cena  ' } });
    await fireEvent.click(saveBtn());
    await waitFor(() => expect(window.location.hash).toBe('#/evento/b/new1'));
    const b = bodyOf('POST');
    expect(Object.keys(b).sort()).toEqual(
      [
        'allDay',
        'calendarId',
        'client_id',
        'description',
        'end',
        'location',
        'start',
        'summary',
      ].sort(),
    );
    expect(b).toMatchObject({ calendarId: 'b', summary: 'Cena', allDay: false });
    expect(b.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.start).toMatch(/^2026-11-02T\d{2}:\d{2}$/);
    expect(String(writes('POST')[0][0])).toBe(`${BASE}/api/agenda`);
  });

  it('dia completo: el fin se envia exclusivo y se ocultan las horas', async () => {
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'Viaje' } });
    await fireEvent.click(screen.getByRole('switch', { name: 'Todo el día' }));
    expect(screen.queryByLabelText('Hora de inicio')).toBeNull();
    await fireEvent.input(input('Hasta el día'), { target: { value: '2026-11-04' } });
    await fireEvent.click(saveBtn());
    await waitFor(() => expect(writes('POST').length).toBe(1));
    expect(bodyOf('POST')).toMatchObject({ allDay: true, start: '2026-11-02', end: '2026-11-05' });
  });

  it('cambiar la fecha de inicio mueve la de fin los mismos dias', async () => {
    await mountCreate();
    await fireEvent.input(input('Fecha de inicio'), { target: { value: '2026-11-02' } });
    await fireEvent.input(input('Fecha de fin'), { target: { value: '2026-11-04' } });
    await fireEvent.input(input('Fecha de inicio'), { target: { value: '2026-11-10' } });
    await waitFor(() =>
      expect((input('Fecha de fin') as HTMLInputElement).value).toBe('2026-11-12'),
    );
    await fireEvent.input(input('Fecha de inicio'), { target: { value: '2026-10-30' } });
    await waitFor(() =>
      expect((input('Fecha de fin') as HTMLInputElement).value).toBe('2026-11-01'),
    );
  });

  it('202 pending es exito: navega al detalle', async () => {
    write = () =>
      json(ev({ id: 'p1', calendarId: 'b', pending: { op: 'insert', error: null } }), 202);
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'X' } });
    await fireEvent.click(saveBtn());
    await waitFor(() => expect(window.location.hash).toBe('#/evento/b/p1'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('fin anterior al inicio: error en linea con foco y sin fetch', async () => {
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'X' } });
    await fireEvent.input(input('Hora de inicio'), { target: { value: '10:00' } });
    await fireEvent.input(input('Hora de fin'), { target: { value: '09:00' } });
    await fireEvent.click(saveBtn());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/fin no puede ser anterior/);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(writes('POST').length).toBe(0);
  });

  it('titulo vacio no envia', async () => {
    await mountCreate();
    await fireEvent.click(saveBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/título es obligatorio/);
    expect(writes('POST').length).toBe(0);
  });

  it('403: muestra el mensaje y conserva lo escrito', async () => {
    write = () => err(403, 'calendar_forbidden');
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'Cena' } });
    await fireEvent.input(input('Ubicación'), { target: { value: 'Casa' } });
    await fireEvent.click(saveBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/No tienes permiso/);
    expect(input('Título').value).toBe('Cena');
    expect(input('Ubicación').value).toBe('Casa');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    expect(saveBtn().disabled).toBe(false);
  });

  it('423 frozen: mensaje sin reintento', async () => {
    write = () => err(423, 'frozen');
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'Cena' } });
    await fireEvent.click(saveBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/hace más de un mes/);
  });

  it('write_pending: Reintentar repite el POST con el mismo client_id', async () => {
    write = (_m, _b, n) =>
      n === 0 ? err(409, 'write_pending') : json(ev({ id: 'n2', calendarId: 'b' }), 201);
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'Cena' } });
    await fireEvent.click(saveBtn());
    await fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(window.location.hash).toBe('#/evento/b/n2'));
    expect(writes('POST').length).toBe(2);
    expect(bodyOf('POST', 1)).toEqual(bodyOf('POST', 0));
  });

  it('error de red: Reintentar visible; guardar de nuevo reutiliza el client_id', async () => {
    let n = 0;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const p = new URL(url).pathname;
      if (init?.method === 'POST') {
        if (n++ === 0) throw new TypeError('offline');
        return json(ev({ id: 'n3', calendarId: 'b' }), 201);
      }
      if (p === '/api/calendars') return json({ calendars: CALS });
      if (p === '/api/settings') return json(settings);
      return json({ connected: true });
    });
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'Cena' } });
    await fireEvent.click(saveBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/No se pudo contactar/);
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
    await fireEvent.click(saveBtn());
    await waitFor(() => expect(writes('POST').length).toBe(2));
    expect(bodyOf('POST', 1).client_id).toBe(bodyOf('POST', 0).client_id);
  });

  it('error con reintento: selector de calendario deshabilitado', async () => {
    write = () => err(409, 'write_pending');
    const title = await mountCreate();
    expect((screen.getByLabelText('Calendario') as HTMLSelectElement).disabled).toBe(false);
    await fireEvent.input(title, { target: { value: 'Cena' } });
    await fireEvent.click(saveBtn());
    await screen.findByRole('button', { name: 'Reintentar' });
    expect((screen.getByLabelText('Calendario') as HTMLSelectElement).disabled).toBe(true);
  });

  it('Reintentar envia el titulo corregido con el mismo client_id', async () => {
    write = (_m, _b, n) =>
      n === 0 ? err(409, 'write_pending') : json(ev({ id: 'n6', calendarId: 'b' }), 201);
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'Cena' } });
    await fireEvent.click(saveBtn());
    await fireEvent.input(title, { target: { value: 'Cena 2' } });
    await fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(writes('POST').length).toBe(2));
    expect(bodyOf('POST', 1).summary).toBe('Cena 2');
    expect(bodyOf('POST', 1).client_id).toBe(bodyOf('POST', 0).client_id);
  });

  it('aria-describedby del error solo en el formulario', async () => {
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'X' } });
    await fireEvent.input(input('Fecha de inicio'), { target: { value: '1969-01-01' } });
    await fireEvent.click(saveBtn());
    await screen.findByRole('alert');
    expect(title.getAttribute('aria-describedby')).toBeNull();
    expect(document.querySelector('form')!.getAttribute('aria-describedby')).toBe('ee-invalid');
  });

  it('409 duplicate: regenera el client_id', async () => {
    write = (_m, _b, n) => (n === 0 ? err(409, 'duplicate') : json(ev({ id: 'n4' }), 201));
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'Cena' } });
    await fireEvent.click(saveBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/Vuelve a guardar/);
    await fireEvent.click(saveBtn());
    await waitFor(() => expect(writes('POST').length).toBe(2));
    expect(bodyOf('POST', 1).client_id).not.toBe(bodyOf('POST', 0).client_id);
  });

  it('google_not_connected al guardar: enlace a Ajustes', async () => {
    write = () => err(409, 'google_not_connected');
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'Cena' } });
    await fireEvent.click(saveBtn());
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'Ir a Ajustes' }).getAttribute('href')).toBe(
      '#/ajustes',
    );
  });

  it('doble envio: un solo POST y boton deshabilitado mientras envia', async () => {
    const d = deferred();
    write = () => d.promise;
    const title = await mountCreate();
    await fireEvent.input(title, { target: { value: 'Cena' } });
    await fireEvent.click(saveBtn());
    expect(saveBtn().disabled).toBe(true);
    expect(saveBtn().textContent).toMatch(/Guardando/);
    await fireEvent.click(saveBtn());
    await fireEvent.submit(saveBtn().form!);
    expect(writes('POST').length).toBe(1);
    d.resolve(json(ev({ id: 'n5', calendarId: 'b' }), 201));
    await waitFor(() => expect(window.location.hash).toBe('#/evento/b/n5'));
  });

  it('Google desconectado: aviso con enlace y sin formulario', async () => {
    connected = false;
    render(EventoEditar, {});
    expect(await screen.findByText(/Google Calendar no está conectado/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Ajustes/ }).getAttribute('href')).toBe('#/ajustes');
    expect(screen.queryByLabelText('Título')).toBeNull();
  });

  it('sin calendarios escribibles: aviso', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const p = new URL(url).pathname;
      if (p === '/api/calendars') return json({ calendars: [CALS[1], CALS[2]] });
      if (p === '/api/settings') return json(settings);
      return json({ connected: true });
    });
    render(EventoEditar, {});
    expect(
      await screen.findByText(/No tienes calendarios en los que se pueda escribir/),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Título')).toBeNull();
  });

  it('error de carga: Reintentar recarga', async () => {
    let fail = true;
    fetchMock.mockImplementation(async (url: string) => {
      const p = new URL(url).pathname;
      if (p === '/api/calendars') return fail ? err(500, 'error') : json({ calendars: CALS });
      if (p === '/api/settings') return json(settings);
      return json({ connected: true });
    });
    render(EventoEditar, {});
    await screen.findByRole('alert');
    fail = false;
    await fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByLabelText('Título')).toBeTruthy();
  });
});

describe('EventoEditar: edicion', () => {
  let back: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    back = vi.fn<() => void>();
    vi.spyOn(window.history, 'back').mockImplementation(back);
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(2);
    write = (_m, body) => json({ ...current, ...(body as object) });
  });

  it('carga el evento, calendario fijo, switch deshabilitado y Guardar sin cambios deshabilitado', async () => {
    await mountEdit();
    expect(input('Título').value).toBe('Dentista');
    expect(input('Hora de inicio').value).toBe('10:00');
    expect(screen.queryByRole('combobox', { name: 'Calendario' })).toBeNull();
    expect(screen.getByText('Cal a')).toBeTruthy();
    const sw = screen.getByRole('switch', { name: 'Todo el día' }) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute('aria-describedby')).toBe('ee-allday-help');
    expect(screen.getByText(/borra el evento y créalo de nuevo/)).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
  });

  it('evento de Google: cancelar no hace PATCH; confirmar envia solo el diff con confirm_external', async () => {
    await mountEdit();
    await fireEvent.input(input('Título'), { target: { value: 'Dentista 2' } });
    await fireEvent.click(saveBtn());
    await fireEvent.click(openDialog().getByRole('button', { name: 'Cancelar' }));
    noDialog();
    expect(writes('PATCH').length).toBe(0);
    expect(input('Título').value).toBe('Dentista 2');

    await fireEvent.click(saveBtn());
    await fireEvent.click(openDialog().getByRole('button', { name: 'Aplicar en Google' }));
    await waitFor(() => expect(back).toHaveBeenCalled());
    expect(writes('PATCH').length).toBe(1);
    expect(String(writes('PATCH')[0][0])).toBe(`${BASE}/api/agenda/a/e1`);
    expect(bodyOf('PATCH')).toEqual({ summary: 'Dentista 2', confirm_external: true });
  });

  it('cambio de hora envia el trio allDay/start/end', async () => {
    current = ev({ origin: 'app' });
    await mountEdit();
    await fireEvent.input(input('Hora de fin'), { target: { value: '11:30' } });
    await fireEvent.click(saveBtn());
    await waitFor(() => expect(writes('PATCH').length).toBe(1));
    expect(bodyOf('PATCH')).toEqual({
      allDay: false,
      start: '2026-10-24T08:00:00Z',
      end: '2026-10-24T11:30',
    });
  });

  it('sin historial: navega al detalle con replace', async () => {
    current = ev({ origin: 'app' });
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(1);
    await mountEdit();
    await fireEvent.input(input('Título'), { target: { value: 'Otro' } });
    await fireEvent.click(saveBtn());
    await waitFor(() => expect(window.location.hash).toBe('#/evento/a/e1'));
    expect(back).not.toHaveBeenCalled();
  });

  it('428 inesperado en evento app: abre la confirmacion y reintenta con confirm_external', async () => {
    current = ev({ origin: 'app' });
    write = (_m, body, n) =>
      n === 0 ? err(428, 'confirmation_required') : json({ ...current, ...(body as object) });
    await mountEdit();
    await fireEvent.input(input('Título'), { target: { value: 'Nuevo' } });
    await fireEvent.click(saveBtn());
    await fireEvent.click(
      await waitFor(() => openDialog().getByRole('button', { name: 'Aplicar en Google' })),
    );
    await waitFor(() => expect(back).toHaveBeenCalled());
    expect(bodyOf('PATCH', 0)).toEqual({ summary: 'Nuevo' });
    expect(bodyOf('PATCH', 1)).toEqual({ summary: 'Nuevo', confirm_external: true });
  });

  it('409 conflict: Sobrescribir repite el mismo PATCH', async () => {
    const server = ev({ summary: 'Cambiado en Google', location: 'Otra' });
    write = (_m, body, n) =>
      n === 0
        ? err(409, 'conflict', { current: server })
        : json({ ...current, ...(body as object) });
    await mountEdit();
    await fireEvent.input(input('Título'), { target: { value: 'Mio' } });
    await fireEvent.click(saveBtn());
    await fireEvent.click(openDialog().getByRole('button', { name: 'Aplicar en Google' }));
    const dlg = await waitFor(() => openDialog());
    expect(dlg.getByText('Cambiado en Google')).toBeTruthy();
    await fireEvent.click(dlg.getByRole('button', { name: 'Sobrescribir con mis cambios' }));
    await waitFor(() => expect(back).toHaveBeenCalled());
    expect(writes('PATCH').length).toBe(2);
    expect(bodyOf('PATCH', 1)).toEqual(bodyOf('PATCH', 0));
  });

  it('409 conflict: Usar la version de Google rellena el formulario y no envia', async () => {
    const server = ev({ summary: 'Cambiado en Google', location: 'Otra' });
    write = () => err(409, 'conflict', { current: server });
    await mountEdit();
    await fireEvent.input(input('Título'), { target: { value: 'Mio' } });
    await fireEvent.click(saveBtn());
    await fireEvent.click(openDialog().getByRole('button', { name: 'Aplicar en Google' }));
    await fireEvent.click(
      await waitFor(() => openDialog().getByRole('button', { name: 'Usar la versión de Google' })),
    );
    noDialog();
    expect(input('Título').value).toBe('Cambiado en Google');
    expect(input('Ubicación').value).toBe('Otra');
    expect(saveBtn().disabled).toBe(true); // ya es el estado inicial
    expect(writes('PATCH').length).toBe(1);
    expect(back).not.toHaveBeenCalled();
  });

  it('409 conflict sin current: Cerrar muestra que ya no existe', async () => {
    current = ev({ origin: 'app' });
    write = () => err(409, 'conflict', { current: null });
    await mountEdit();
    await fireEvent.input(input('Título'), { target: { value: 'Mio' } });
    await fireEvent.click(saveBtn());
    await fireEvent.click(
      await waitFor(() => openDialog().getByRole('button', { name: 'Cerrar' })),
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/ya no existe en Google/);
    expect(input('Título').value).toBe('Mio');
  });

  it('423 al guardar: mensaje y se conserva lo escrito', async () => {
    current = ev({ origin: 'app' });
    write = () => err(423, 'frozen');
    await mountEdit();
    await fireEvent.input(input('Título'), { target: { value: 'Mio' } });
    await fireEvent.click(saveBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/hace más de un mes/);
    expect(input('Título').value).toBe('Mio');
  });

  it('doble envio en edicion: un solo PATCH', async () => {
    current = ev({ origin: 'app' });
    const d = deferred();
    write = () => d.promise;
    await mountEdit();
    await fireEvent.input(input('Título'), { target: { value: 'Mio' } });
    await fireEvent.click(saveBtn());
    await fireEvent.submit(saveBtn().form!);
    expect(writes('PATCH').length).toBe(1);
    d.resolve(json(current));
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
  });

  it.each([
    [
      { recurringEventId: 'r1', htmlLink: 'https://calendar.google.com/x' },
      /recurrentes se editan/,
    ],
    [{ frozen: true }, /hace más de un mes/],
    [{ writable: false }, /solo lectura/],
  ])('solo lectura %o: aviso y sin formulario', async (over, text) => {
    current = ev(over);
    await mountEdit();
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByLabelText('Título')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Guardar' })).toBeNull();
  });

  it('recurrente enlaza a Google Calendar', async () => {
    current = ev({ recurringEventId: 'r1', htmlLink: 'https://calendar.google.com/x' });
    await mountEdit();
    expect(
      screen.getByRole('link', { name: 'Abrir en Google Calendar' }).getAttribute('href'),
    ).toBe('https://calendar.google.com/x');
  });

  it('404 al cargar: el evento ya no existe', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === '/api/calendars'
        ? json({ calendars: CALS })
        : err(404, 'not_found'),
    );
    await mountEdit();
    expect(screen.getByText('El evento ya no existe.')).toBeTruthy();
  });
});
