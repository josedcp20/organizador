import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import NotaRapida from './NotaRapida.svelte';
import App from '../App.svelte';
import Login from './Login.svelte';
import { TOKEN_KEY, clearToken, setToken, setReturnTo } from '../lib/auth';
import { quickDraft } from '../lib/notes';

const BASE = 'https://worker.example.workers.dev';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let respond: () => Response;
let bodies: unknown[];

beforeEach(() => {
  quickDraft.text = '';
  bodies = [];
  respond = () => json({ id: 'q1', body: 'x', expiresAt: null, createdAt: 'now' }, 201);
  window.location.hash = '#/nota-rapida';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(url);
      if (u.pathname !== '/api/quick-notes' || init?.method !== 'POST') {
        throw new Error(`fetch inesperado: ${u.pathname}`);
      }
      bodies.push(JSON.parse(init.body!));
      return respond();
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
  window.sessionStorage.clear();
});

describe('NotaRapida', () => {
  it('enfoca el textarea y usa "Solo hoy" por defecto', () => {
    render(NotaRapida);
    expect(document.activeElement).toBe(screen.getByLabelText('Texto de la nota'));
    expect((screen.getByLabelText('Caducidad') as HTMLSelectElement).value).toBe('today');
  });

  it('guarda, confirma y navega a Hoy', async () => {
    render(NotaRapida);
    await fireEvent.input(screen.getByLabelText('Texto de la nota'), {
      target: { value: 'llamar a mama' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByText('Nota guardada')).toBeTruthy();
    expect(bodies).toEqual([{ body: 'llamar a mama', expiry: { type: 'today' } }]);
    await waitFor(() => expect(window.location.hash).toBe('#/hoy'));
  });

  it('Ctrl+Enter guarda', async () => {
    render(NotaRapida);
    const ta = screen.getByLabelText('Texto de la nota');
    await fireEvent.input(ta, { target: { value: 'atajo' } });
    await fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(bodies.length).toBe(1));
  });

  it('si falla conserva el texto y muestra error', async () => {
    respond = () => json({ error: { code: 'x', message: 'm' } }, 500);
    render(NotaRapida);
    const ta = screen.getByLabelText('Texto de la nota') as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: 'no perder' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByText('Error del servidor (500).')).toBeTruthy();
    expect(ta.value).toBe('no perder');
    expect(window.location.hash).toBe('#/nota-rapida');
  });

  it('no guarda texto vacio', async () => {
    render(NotaRapida);
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByText('Escribe algo antes de guardar.')).toBeTruthy();
    expect(bodies.length).toBe(0);
  });

  it('401 cierra sesion', async () => {
    respond = () => json({ error: { code: 'unauthorized', message: 'no' } }, 401);
    render(NotaRapida);
    await fireEvent.input(screen.getByLabelText('Texto de la nota'), { target: { value: 'a' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull());
    expect(window.location.hash).toBe('#/login');
  });
});

describe('borrador de nota rapida', () => {
  it('tras 401 el texto se restaura al volver a montar y no va a storage', async () => {
    respond = () => json({ error: { code: 'unauthorized', message: 'no' } }, 401);
    render(NotaRapida);
    await fireEvent.input(screen.getByLabelText('Texto de la nota'), {
      target: { value: 'texto valioso' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull());
    cleanup();
    setToken('tok-123');
    render(NotaRapida);
    expect((screen.getByLabelText('Texto de la nota') as HTMLTextAreaElement).value).toBe(
      'texto valioso',
    );
    for (const st of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < st.length; i++) {
        expect(st.getItem(st.key(i)!)).not.toContain('texto valioso');
      }
    }
  });

  it('se limpia al guardar con exito', async () => {
    render(NotaRapida);
    await fireEvent.input(screen.getByLabelText('Texto de la nota'), { target: { value: 'ok' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await screen.findByText('Nota guardada');
    expect(quickDraft.text).toBe('');
  });
});

describe('ruta de retorno tras login', () => {
  it.each(['https://evil', 'ajustes'])('retorno %s va a #/hoy', async (ret) => {
    clearToken();
    setReturnTo(ret);
    window.location.hash = '#/login';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ version: '1', tz: 'Europe/Madrid' })),
    );
    render(Login);
    const input = screen.getByLabelText(/token/i);
    await fireEvent.input(input, { target: { value: 'tok-nuevo' } });
    await fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(window.location.hash).toBe('#/hoy'));
  });
});

describe('guard de sesion en #/nota-rapida', () => {
  it('sin sesion en #/notas no deja ruta de retorno', async () => {
    clearToken();
    setReturnTo('nota-rapida'); // resto de una visita anterior
    window.location.hash = '#/notas';
    render(App);
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
    expect(window.sessionStorage.getItem('organizador_return')).toBeNull();
  });

  it('sin sesion en #/nota-rapida guarda la ruta de retorno', async () => {
    clearToken();
    window.location.hash = '#/nota-rapida';
    render(App);
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
    expect(window.sessionStorage.getItem('organizador_return')).toBe('nota-rapida');
  });

  it('sin token redirige a login y vuelve tras iniciar sesion', async () => {
    clearToken();
    window.location.hash = '#/nota-rapida';
    render(App);
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
    cleanup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ version: '1', tz: 'Europe/Madrid' })),
    );
    render(Login);
    const input = screen.getByLabelText(/token/i);
    await fireEvent.input(input, { target: { value: 'tok-nuevo' } });
    await fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(window.location.hash).toBe('#/nota-rapida'));
  });
});
