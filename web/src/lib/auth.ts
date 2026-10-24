import { writable } from 'svelte/store';

/** Clave de localStorage del token de acceso (seccion 5 del plan). */
export const TOKEN_KEY = 'organizador_token';

/** Prefijo de las claves de localStorage con datos cacheados; se borran al cerrar sesion. */
export const CACHE_PREFIX = 'organizador_cache:';

/** Ruta a la que volver tras iniciar sesion (solo se guarda para la nota rapida). */
const RETURN_KEY = 'organizador_return';

export function setReturnTo(route: string): void {
  try {
    window.sessionStorage.setItem(RETURN_KEY, route);
  } catch {
    // ignorar
  }
}

/** Devuelve y borra la ruta de retorno guardada. */
export function takeReturnTo(): string | null {
  try {
    const r = window.sessionStorage.getItem(RETURN_KEY);
    window.sessionStorage.removeItem(RETURN_KEY);
    return r;
  } catch {
    return null;
  }
}

function clearCachedData(): void {
  try {
    const ls = window.localStorage;
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) ls.removeItem(k);
    }
  } catch {
    // ignorar
  }
}

export interface MeInfo {
  version: string;
  tz: string;
}

function readToken(): string | null {
  try {
    const t = window.localStorage.getItem(TOKEN_KEY);
    return t && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  return readToken();
}

/** true si el token es de sesion Face ID (`s1.`) y no el estatico. */
export function isSessionToken(token: string | null = readToken()): boolean {
  return token !== null && token.startsWith('s1.');
}

export function isLoggedIn(): boolean {
  return readToken() !== null;
}

/** Estado de sesion reactivo (true = hay token guardado). */
export const session = writable<boolean>(isLoggedIn());

/** Datos discretos de /api/me de la sesion actual (version/tz). */
export const meInfo = writable<MeInfo | null>(null);

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Sin almacenamiento: la sesion no se puede guardar.
    session.set(false);
    return;
  }
  session.set(true);
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignorar
  }
  clearCachedData();
  meInfo.set(null);
  session.set(false);
}

// Sincroniza entre pestanas/ventanas.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === TOKEN_KEY || e.key === null) session.set(isLoggedIn());
  });
}
