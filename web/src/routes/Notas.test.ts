import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import Notas from './Notas.svelte';
import { CACHE_PREFIX, TOKEN_KEY, clearToken, setToken } from '../lib/auth';
import { expiryLabel } from '../lib/notes';

const BASE = 'https://worker.example.workers.dev';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const note = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'note',
  title: null,
  body: `cuerpo ${id}`,
  pinned: false,
  expiresAt: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
  ...over,
});

let handlers: Record<string, (init?: { body?: string }) => Response | Promise<Response>>;
let calls: { key: string; body?: string }[];

beforeEach(() => {
  handlers = {};
  calls = [];
  window.location.hash = '#/notas';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(url);
      const key = `${init?.method ?? 'GET'} ${u.pathname}`;
      calls.push({ key, body: init?.body });
      const h = handlers[key] ?? handlers[key.replace(/\/[^/]+$/, '/:id')];
      if (!h) throw new Error(`fetch inesperado: ${key}`);
      return h(init);
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
  window.localStorage.clear();
});

describe('Notas', () => {
  it('lista con fijadas primero, fijada marcada y filtro de rapidas', async () => {
    handlers['GET /api/notes'] = () =>
      json({
        notes: [
          note('a', { body: 'normal reciente', updatedAt: '2026-10-22T10:00:00.000Z' }),
          note('b', { body: 'fijada antigua', pinned: true }),
          note('q', { kind: 'quick', body: 'rapida uno' }),
        ],
      });
    render(Notas);
    await screen.findByText('fijada antigua');
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('fijada antigua');
    expect(items[1].textContent).toContain('normal reciente');
    expect(screen.getByText('Fijada')).toBeTruthy();
    expect(screen.queryByText('rapida uno')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: /Rápidas/ }));
    expect(screen.getByText('rapida uno')).toBeTruthy();
    expect(screen.queryByText('fijada antigua')).toBeNull();
  });

  it('muestra vacio y error', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [] });
    render(Notas);
    expect(await screen.findByText('No hay notas todavía.')).toBeTruthy();
    cleanup();
    handlers['GET /api/notes'] = () => json({ error: { code: 'x', message: 'm' } }, 500);
    render(Notas);
    expect(
      await screen.findByText(/No se pudieron cargar las notas\. Error del servidor \(500\)/),
    ).toBeTruthy();
  });

  it('crea una nota con caducidad en dias', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [] });
    handlers['POST /api/notes'] = (init) =>
      json(note('n1', { body: JSON.parse(init!.body!).body }), 201);
    render(Notas);
    await screen.findByText('No hay notas todavía.');
    await fireEvent.click(screen.getByRole('button', { name: 'Nueva nota' }));
    await fireEvent.input(screen.getByLabelText('Nota'), { target: { value: 'comprar pan' } });
    await fireEvent.change(screen.getByLabelText('Caducidad'), { target: { value: 'days' } });
    await fireEvent.input(screen.getByLabelText('Días'), { target: { value: '3' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await screen.findByText('comprar pan');
    const post = calls.find((c) => c.key === 'POST /api/notes')!;
    expect(JSON.parse(post.body!)).toEqual({
      body: 'comprar pan',
      title: null,
      pinned: false,
      expiry: { type: 'days', days: 3 },
    });
  });

  it('borrar pide confirmacion y no llama a la API si se cancela', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [note('a', { body: 'borrame' })] });
    handlers['DELETE /api/notes/:id'] = () => new Response(null, { status: 204 });
    render(Notas);
    await screen.findByText('borrame');
    await fireEvent.click(screen.getByRole('button', { name: 'Borrar' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
    await fireEvent.click(screen.getByRole('button', { name: 'Borrar' }));
    const dlg = screen.getByRole('alertdialog');
    expect(within(dlg).getByText('¿Borrar esta nota?')).toBeTruthy();
    await fireEvent.click(within(dlg).getByRole('button', { name: 'Confirmar borrado' }));
    await waitFor(() => expect(screen.queryByText('borrame')).toBeNull());
    expect(calls.some((c) => c.key === 'DELETE /api/notes/a')).toBe(true);
  });

  it('fija una nota', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [note('a', { body: 'x1' })] });
    handlers['PATCH /api/notes/:id'] = () => json(note('a', { body: 'x1', pinned: true }));
    render(Notas);
    await screen.findByText('x1');
    await fireEvent.click(screen.getByRole('button', { name: 'Fijar' }));
    await screen.findByText('Fijada');
    expect(JSON.parse(calls.find((c) => c.key.startsWith('PATCH'))!.body!)).toEqual({
      pinned: true,
    });
  });

  it('edita una nota sin tocar la caducidad', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [note('a', { body: 'viejo' })] });
    handlers['PATCH /api/notes/:id'] = () => json(note('a', { body: 'nuevo' }));
    render(Notas);
    await screen.findByText('viejo');
    await fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    await fireEvent.input(screen.getByLabelText('Nota'), { target: { value: 'nuevo' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await screen.findByText('nuevo');
    const body = JSON.parse(calls.find((c) => c.key.startsWith('PATCH'))!.body!);
    expect(body.body).toBe('nuevo');
    expect('expiry' in body).toBe(false);
  });

  it('sin conexion usa la ultima lista guardada', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [note('a', { body: 'cacheada' })] });
    render(Notas);
    await screen.findByText('cacheada');
    cleanup();
    handlers['GET /api/notes'] = () => {
      throw new TypeError('offline');
    };
    render(Notas);
    expect(await screen.findByText('cacheada')).toBeTruthy();
    expect(screen.getByText(/Sin conexión, datos guardados/)).toBeTruthy();
  });

  it('401 cierra sesion y borra la cache', async () => {
    window.localStorage.setItem(`${CACHE_PREFIX}notes`, '{"notes":[],"savedAt":"x"}');
    handlers['GET /api/notes'] = () =>
      json({ error: { code: 'unauthorized', message: 'no' } }, 401);
    render(Notas);
    await waitFor(() => expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull());
    expect(window.localStorage.getItem(`${CACHE_PREFIX}notes`)).toBeNull();
    expect(window.location.hash).toBe('#/login');
  });
});

function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('Notas robustez', () => {
  it('GET tardio tras logout no reescribe la cache', async () => {
    const d = deferred();
    handlers['GET /api/notes'] = () => d.promise;
    render(Notas);
    await waitFor(() => expect(calls.length).toBe(1));
    clearToken();
    cleanup();
    d.resolve(json({ notes: [note('a')] }));
    await settle();
    expect(window.localStorage.getItem(`${CACHE_PREFIX}notes`)).toBeNull();
  });

  it('GET tardio tras logout sin desmontar no reescribe la cache', async () => {
    const d = deferred();
    handlers['GET /api/notes'] = () => d.promise;
    render(Notas);
    await waitFor(() => expect(calls.length).toBe(1));
    clearToken();
    d.resolve(json({ notes: [note('a')] }));
    await settle();
    expect(window.localStorage.getItem(`${CACHE_PREFIX}notes`)).toBeNull();
  });

  it('POST tardio tras desmontar no escribe cache', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [] });
    const d = deferred();
    handlers['POST /api/notes'] = () => d.promise;
    render(Notas);
    await screen.findByText('No hay notas todavía.');
    await fireEvent.click(screen.getByRole('button', { name: 'Nueva nota' }));
    await fireEvent.input(screen.getByLabelText('Nota'), { target: { value: 'tarde' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    cleanup();
    window.localStorage.removeItem(`${CACHE_PREFIX}notes`);
    d.resolve(json(note('n1', { body: 'tarde' }), 201));
    await settle();
    expect(window.localStorage.getItem(`${CACHE_PREFIX}notes`)).toBeNull();
  });

  it('POST + Actualizar no duplica la nota', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [] });
    const d = deferred();
    handlers['POST /api/notes'] = () => d.promise;
    render(Notas);
    await screen.findByText('No hay notas todavía.');
    await fireEvent.click(screen.getByRole('button', { name: 'Nueva nota' }));
    await fireEvent.input(screen.getByLabelText('Nota'), { target: { value: 'unica' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    const refresh = screen.getByRole('button', { name: 'Actualizar' }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    handlers['GET /api/notes'] = () => json({ notes: [note('n1', { body: 'unica' })] });
    d.resolve(json(note('n1', { body: 'unica' }), 201));
    await screen.findByText('unica');
    await fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    await waitFor(() => expect(calls.filter((c) => c.key === 'GET /api/notes').length).toBe(2));
    await settle();
    expect(screen.getAllByText('unica').length).toBe(1);
  });

  it('un GET viejo no pisa un toggle de fijar', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [note('a', { body: 'pin-me' })] });
    handlers['PATCH /api/notes/:id'] = () => json(note('a', { body: 'pin-me', pinned: true }));
    render(Notas);
    await screen.findByText('pin-me');
    const d = deferred();
    handlers['GET /api/notes'] = () => d.promise;
    await fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Fijar' }));
    await screen.findByText('Fijada');
    d.resolve(json({ notes: [note('a', { body: 'pin-me' })] }));
    await settle();
    expect(screen.getByText('Fijada')).toBeTruthy();
  });

  it('PATCH 404 quita la nota de lista y cache', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [note('a', { body: 'fantasma' })] });
    handlers['PATCH /api/notes/:id'] = () => json({ error: { code: 'nf', message: 'm' } }, 404);
    render(Notas);
    await screen.findByText('fantasma');
    await fireEvent.click(screen.getByRole('button', { name: 'Fijar' }));
    await waitFor(() => expect(screen.queryByText('fantasma')).toBeNull());
    const cache = JSON.parse(window.localStorage.getItem(`${CACHE_PREFIX}notes`)!);
    expect(cache.notes).toEqual([]);
  });

  it('DELETE 404 quita la nota', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [note('a', { body: 'ya borrada' })] });
    handlers['DELETE /api/notes/:id'] = () => json({ error: { code: 'nf', message: 'm' } }, 404);
    render(Notas);
    await screen.findByText('ya borrada');
    await fireEvent.click(screen.getByRole('button', { name: 'Borrar' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirmar borrado' }));
    await waitFor(() => expect(screen.queryByText('ya borrada')).toBeNull());
  });

  it('la cache offline no muestra notas caducadas', async () => {
    window.localStorage.setItem(
      `${CACHE_PREFIX}notes`,
      JSON.stringify({
        savedAt: '2026-10-20T10:00:00.000Z',
        notes: [
          note('a', { body: 'vigente' }),
          note('b', { body: 'vencida', expiresAt: '2020-01-01T00:00:00.000Z' }),
        ],
      }),
    );
    handlers['GET /api/notes'] = () => {
      throw new TypeError('offline');
    };
    render(Notas);
    await screen.findByText('vigente');
    expect(screen.queryByText('vencida')).toBeNull();
  });

  it('no muestra notas caducadas devueltas por el servidor', async () => {
    handlers['GET /api/notes'] = () =>
      json({
        notes: [
          note('a', { body: 'vigente' }),
          note('b', { body: 'vencida', expiresAt: '2020-01-01T00:00:00.000Z' }),
        ],
      });
    render(Notas);
    await screen.findByText('vigente');
    expect(screen.queryByText('vencida')).toBeNull();
  });

  it('fallo al crear deja el formulario abierto con el texto', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [] });
    handlers['POST /api/notes'] = () => json({ error: { code: 'x', message: 'm' } }, 500);
    render(Notas);
    await screen.findByText('No hay notas todavía.');
    await fireEvent.click(screen.getByRole('button', { name: 'Nueva nota' }));
    await fireEvent.input(screen.getByLabelText('Nota'), { target: { value: 'conservame' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await screen.findByText('Error del servidor (500).');
    expect((screen.getByLabelText('Nota') as HTMLTextAreaElement).value).toBe('conservame');
  });

  it('borrar enfoca Cancelar y al cancelar vuelve el foco a Borrar', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [note('a', { body: 'foco' })] });
    render(Notas);
    await screen.findByText('foco');
    await fireEvent.click(screen.getByRole('button', { name: 'Borrar' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancelar' })),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Borrar' })),
    );
  });
});

describe('clearToken', () => {
  it('borra solo claves con prefijo de cache', () => {
    window.localStorage.setItem(`${CACHE_PREFIX}notes`, 'x');
    window.localStorage.setItem(`${CACHE_PREFIX}otra`, 'y');
    window.localStorage.setItem('otra_cosa', 'z');
    window.localStorage.setItem('organizador_cache', 'sin dos puntos');
    clearToken();
    expect(window.localStorage.getItem(`${CACHE_PREFIX}notes`)).toBeNull();
    expect(window.localStorage.getItem(`${CACHE_PREFIX}otra`)).toBeNull();
    expect(window.localStorage.getItem('otra_cosa')).toBe('z');
    expect(window.localStorage.getItem('organizador_cache')).toBe('sin dos puntos');
  });
});

describe('expiryLabel', () => {
  const now = Date.parse('2026-10-23T10:00:00Z'); // 12:00 Madrid
  it('sin caducidad', () => expect(expiryLabel(null, now)).toBe('sin caducidad'));
  it('hoy a las 00:00', () =>
    expect(expiryLabel('2026-10-23T22:00:00.000Z', now)).toBe('caduca hoy a las 00:00'));
  it('en N dias', () => {
    expect(expiryLabel('2026-10-25T23:00:00.000Z', now)).toBe('caduca en 3 días');
    expect(expiryLabel('2026-10-24T22:00:00.000Z', now)).toBe('caduca en 2 días');
  });
  it('caducada', () => expect(expiryLabel('2026-10-23T09:00:00.000Z', now)).toBe('caducada'));
});

describe('Notas alarmas', () => {
  const quick = (id: string, over: Record<string, unknown> = {}) =>
    note(id, { kind: 'quick', body: `rapida ${id}`, ...over });
  const R = '2030-10-27T17:30:00.000Z';

  it('muestra el estado de la alarma (pending, sent, gave_up) en hora de Madrid', async () => {
    handlers['GET /api/notes'] = () =>
      json({
        notes: [
          quick('p', { remindAt: R, remindState: 'pending' }),
          quick('s', { remindAt: R, remindState: 'sent' }),
          quick('g', { remindAt: R, remindState: 'gave_up' }),
        ],
      });
    render(Notas);
    await fireEvent.click(await screen.findByRole('button', { name: /Rápidas/ }));
    expect(screen.getByText('Alarma: dom 27/10 18:30')).toBeTruthy();
    expect(screen.getByText('Sonó a las 18:30')).toBeTruthy();
    expect(screen.getByText('No se pudo avisar')).toBeTruthy();
  });

  it('deep link ?nota=<id> selecciona Rapidas, resalta y enfoca la nota', async () => {
    window.location.hash = '#/notas?nota=q2';
    handlers['GET /api/notes'] = () => json({ notes: [note('n1'), quick('q1'), quick('q2')] });
    render(Notas);
    const el = await screen.findByText('rapida q2');
    const li = el.closest('li')!;
    await waitFor(() => expect(document.activeElement).toBe(li));
    expect(li.classList.contains('highlight')).toBe(true);
    expect(screen.getByRole('button', { name: /Rápidas/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByText('cuerpo n1')).toBeNull();
  });

  it('deep link con id inexistente muestra Banner', async () => {
    window.location.hash = '#/notas?nota=zzz';
    handlers['GET /api/notes'] = () => json({ notes: [quick('q1')] });
    render(Notas);
    expect(await screen.findByText(/La nota ya no existe/)).toBeTruthy();
  });

  it('quitar la alarma envia remind_at null', async () => {
    handlers['GET /api/notes'] = () =>
      json({ notes: [quick('q1', { remindAt: R, remindState: 'pending' })] });
    handlers['PATCH /api/notes/:id'] = () => json(quick('q1'));
    render(Notas);
    await fireEvent.click(await screen.findByRole('button', { name: /Rápidas/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    expect((screen.getByLabelText('Hora de la alarma') as HTMLSelectElement).value).toBe('18');
    await fireEvent.click(screen.getByRole('button', { name: 'Quitar alarma' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(calls.some((c) => c.key.startsWith('PATCH'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.key.startsWith('PATCH'))!.body!).remind_at).toBeNull();
  });

  it('editar solo el texto no envia remind_at', async () => {
    handlers['GET /api/notes'] = () =>
      json({ notes: [quick('q1', { remindAt: R, remindState: 'pending' })] });
    handlers['PATCH /api/notes/:id'] = () => json(quick('q1'));
    render(Notas);
    await fireEvent.click(await screen.findByRole('button', { name: /Rápidas/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    await fireEvent.input(screen.getByLabelText('Nota'), { target: { value: 'otro' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(calls.some((c) => c.key.startsWith('PATCH'))).toBe(true));
    expect('remind_at' in JSON.parse(calls.find((c) => c.key.startsWith('PATCH'))!.body!)).toBe(
      false,
    );
  });

  it('el 400 de la API se muestra en espanol', async () => {
    handlers['GET /api/notes'] = () => json({ notes: [quick('q1')] });
    handlers['PATCH /api/notes/:id'] = () => json({ error: { code: 'bad', message: 'm' } }, 400);
    render(Notas);
    await fireEvent.click(await screen.findByRole('button', { name: /Rápidas/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByText(/Revisa el texto, la caducidad y la alarma/)).toBeTruthy();
  });
});
