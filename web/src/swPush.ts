// Funciones puras del service worker para Web Push (testeables sin SW). Sin DOM ni /api.

export interface ParsedPush {
  title: string;
  options: { body: string; tag?: string; icon: string; badge: string; data: { url: string } };
}

const FALLBACK_TITLE = 'Organizador';
const FALLBACK_BODY = 'Tienes novedades';
const ICON = 'icons/icon-192.png';
const DEFAULT_URL = '#/hoy';

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined;

/** Ruta de la app a la que lleva la notificacion: solo hashes `#/...`; cualquier otra cosa -> `#/hoy`. */
export function safeHash(url: unknown): string {
  return typeof url === 'string' && url.startsWith('#/') && url.length <= 512 ? url : DEFAULT_URL;
}

/**
 * Texto del push -> notificacion. Siempre devuelve algo que mostrar: iOS revoca la suscripcion
 * si un push no muestra notificacion.
 */
export function parsePush(text: string | null | undefined): ParsedPush {
  let data: Record<string, unknown> = {};
  try {
    const j: unknown = text ? JSON.parse(text) : null;
    if (j && typeof j === 'object') data = j as Record<string, unknown>;
  } catch {
    // payload invalido: notificacion generica
  }
  const tag = str(data.tag, 64);
  return {
    title: str(data.title, 120) ?? FALLBACK_TITLE,
    options: {
      body: str(data.body, 500) ?? FALLBACK_BODY,
      ...(tag ? { tag } : {}),
      icon: ICON,
      badge: ICON,
      data: { url: safeHash(data.url) },
    },
  };
}

/** URL absoluta a abrir: scope del SW + hash permitido. */
export function clickTarget(scope: string, url: unknown): string {
  return new URL(safeHash(url), scope).href;
}
