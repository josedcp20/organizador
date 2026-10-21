import { writable } from 'svelte/store';

/** Clave de localStorage del token de acceso (seccion 5 del plan). */
export const TOKEN_KEY = 'organizador_token';

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
  meInfo.set(null);
  session.set(false);
}

// Sincroniza entre pestanas/ventanas.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === TOKEN_KEY || e.key === null) session.set(isLoggedIn());
  });
}
