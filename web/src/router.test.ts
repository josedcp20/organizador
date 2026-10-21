import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  getCurrentRoute,
  getQueryParams,
  navigateTo,
  getRouteInfo,
  matchRoute,
  currentRoute,
} from './router';

const wait = () => new Promise((r) => setTimeout(r, 20));

describe('Router', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  describe('matchRoute', () => {
    it('should match valid routes', () => {
      expect(matchRoute('hoy')).toBe('hoy');
      expect(matchRoute('#/calendario')).toBe('calendario');
      expect(matchRoute('notas')).toBe('notas');
      expect(matchRoute('#/nota-rapida')).toBe('nota-rapida');
      expect(matchRoute('ajustes')).toBe('ajustes');
      expect(matchRoute('#/login')).toBe('login');
    });

    it('should ignore the query string', () => {
      expect(matchRoute('#/login?token=abc')).toBe('login');
      expect(matchRoute('nota-rapida?text=hola')).toBe('nota-rapida');
    });

    it('should return null for invalid routes', () => {
      expect(matchRoute('invalid')).toBeNull();
      expect(matchRoute('#/nonexistent?x=1')).toBeNull();
      expect(matchRoute('')).toBeNull();
    });
  });

  describe('getCurrentRoute', () => {
    it('should fallback to hoy when hash is empty or #/', () => {
      expect(getCurrentRoute()).toBe('hoy');
      window.location.hash = '#/';
      expect(getCurrentRoute()).toBe('hoy');
    });

    it('should return the current route from hash', () => {
      for (const r of ['calendario', 'notas', 'ajustes'] as const) {
        window.location.hash = `#/${r}`;
        expect(getCurrentRoute()).toBe(r);
      }
    });

    it('should fallback to hoy for invalid routes', () => {
      window.location.hash = '#/invalid';
      expect(getCurrentRoute()).toBe('hoy');
    });

    it('should resolve routes that carry a query string', () => {
      window.location.hash = '#/login?token=x';
      expect(getCurrentRoute()).toBe('login');
      window.location.hash = '#/nota-rapida?text=hola%20mundo';
      expect(getCurrentRoute()).toBe('nota-rapida');
    });
  });

  describe('getQueryParams', () => {
    it('should expose query parameters', () => {
      window.location.hash = '#/login?token=abc';
      expect(getQueryParams().get('token')).toBe('abc');
      window.location.hash = '#/nota-rapida?text=hola%20mundo';
      expect(getQueryParams().get('text')).toBe('hola mundo');
    });

    it('should be empty without query', () => {
      window.location.hash = '#/hoy';
      expect([...getQueryParams()]).toEqual([]);
    });
  });

  describe('getRouteInfo', () => {
    it('should return route info with path', () => {
      expect(getRouteInfo('hoy')).toEqual({ name: 'hoy', path: '#/hoy' });
    });

    it('should use current route if not specified', () => {
      window.location.hash = '#/calendario';
      expect(getRouteInfo()).toEqual({ name: 'calendario', path: '#/calendario' });
    });
  });

  describe('navigateTo', () => {
    it('should set window.location.hash', () => {
      navigateTo('calendario');
      expect(window.location.hash).toBe('#/calendario');
      navigateTo('nota-rapida');
      expect(window.location.hash).toBe('#/nota-rapida');
    });
  });

  describe('currentRoute store', () => {
    it('should react to hashchange', async () => {
      const seen: string[] = [];
      const unsub = currentRoute.subscribe((r) => seen.push(r));
      window.location.hash = '#/notas';
      await wait();
      expect(get(currentRoute)).toBe('notas');
      window.location.hash = '#/login?token=x';
      await wait();
      expect(seen[seen.length - 1]).toBe('login');
      unsub();
    });
  });
});
