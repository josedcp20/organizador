import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import App from './App.svelte';
import { setToken, clearToken } from './lib/auth';

describe('App mount', () => {
  beforeEach(() => {
    window.location.hash = '';
    setToken('t');
  });
  afterEach(() => {
    cleanup();
    clearToken();
  });

  it('renders NotaRapida on #/nota-rapida', () => {
    window.location.hash = '#/nota-rapida';
    render(App);
    expect(screen.getByRole('heading', { name: 'Nota Rápida' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Escribe tu nota...')).toBeTruthy();
  });

  it('falls back to Hoy on unknown route', () => {
    window.location.hash = '#/desconocida';
    render(App);
    expect(screen.getByRole('heading', { name: 'Hoy' })).toBeTruthy();
  });

  it('renders Login on #/login without Layout', () => {
    window.location.hash = '#/login';
    render(App);
    expect(screen.getByRole('heading', { name: 'Organizador' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Navegación principal' })).toBeNull();
  });

  it('switches view on hashchange and marks the active link', async () => {
    window.location.hash = '#/hoy';
    render(App);
    window.location.hash = '#/notas';
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Notas' })).toBeTruthy());
    const active = screen
      .getAllByRole('link', { name: /Notas/ })
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(active.length).toBe(2);
  });

  it('mounts EventoEditar on #/nuevo-evento and #/editar-evento', async () => {
    window.location.hash = '#/nuevo-evento?fecha=2026-11-02';
    render(App);
    expect(screen.getByRole('heading', { name: 'Nuevo evento' })).toBeTruthy();
    window.location.hash = '#/editar-evento/a/b';
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Editar evento' })).toBeTruthy(),
    );
  });
});
