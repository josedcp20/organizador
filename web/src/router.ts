import { readable } from 'svelte/store';

// Router basado en hash para la SPA: `#/ruta?clave=valor`
export type Route = 'hoy' | 'calendario' | 'notas' | 'nota-rapida' | 'ajustes' | 'evento' | 'login';

export interface RouteInfo {
  name: Route;
  path: string;
}

const ROUTES: Record<Route, string> = {
  hoy: '#/hoy',
  calendario: '#/calendario',
  notas: '#/notas',
  'nota-rapida': '#/nota-rapida',
  ajustes: '#/ajustes',
  evento: '#/evento',
  login: '#/login',
};

const VALID_ROUTES = new Set<string>(Object.keys(ROUTES));

function fullPath(hash: string): string {
  const h = hash.startsWith('#/') ? hash.slice(2) : hash;
  return h.split('?')[0];
}

/** Nombre de ruta: solo `evento` admite segmentos extra (`#/evento/<cal>/<id>`). */
function pathPart(hash: string): string {
  const [name, ...rest] = fullPath(hash).split('/');
  return name === 'evento' || rest.length === 0 ? name : fullPath(hash);
}

/** Segmentos tras el nombre de ruta, decodificados (`#/evento/a%40b/c` -> ['a@b', 'c']). */
export function getRouteParams(hash: string = window.location.hash): string[] {
  const [, ...rest] = fullPath(hash).split('/');
  return rest.map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
}

/** Hash de la pantalla de detalle de un evento (ids codificados). */
export function eventHref(calendarId: string, eventId: string): string {
  return `#/evento/${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}`;
}

export function getCurrentRoute(): Route {
  const name = pathPart(window.location.hash);
  return VALID_ROUTES.has(name) ? (name as Route) : 'hoy';
}

/** Parametros de query del hash actual (`#/login?token=abc`). */
export function getQueryParams(): URLSearchParams {
  const hash = window.location.hash;
  const i = hash.indexOf('?');
  return new URLSearchParams(i === -1 ? '' : hash.slice(i + 1));
}

export function navigateTo(route: Route): void {
  window.location.hash = ROUTES[route];
}

export function getRouteInfo(route?: Route): RouteInfo {
  const name = route || getCurrentRoute();
  return { name, path: ROUTES[name] };
}

export function matchRoute(path: string): Route | null {
  const name = pathPart(path);
  return VALID_ROUTES.has(name) ? (name as Route) : null;
}

/** Ruta actual reactiva; unica fuente de verdad para la UI. */
export const currentRoute = readable<Route>(getCurrentRoute(), (set) => {
  const update = () => set(getCurrentRoute());
  update();
  window.addEventListener('hashchange', update);
  return () => window.removeEventListener('hashchange', update);
});

/** Parametros de ruta actuales, reactivos. */
export const currentParams = readable<string[]>(getRouteParams(), (set) => {
  const update = () => set(getRouteParams());
  update();
  window.addEventListener('hashchange', update);
  return () => window.removeEventListener('hashchange', update);
});
