import {
  GOOGLE_CONNECT_REASONS,
  type GoogleConnectReason,
  type GoogleDisconnectReason,
  type GoogleStatus,
  type GoogleTicketResponse,
} from '@organizador/shared';
import { ApiError, apiFetch, getApiBase } from './api';

/** Indireccion para poder simular la navegacion en tests (jsdom no navega). */
export const nav = {
  go(url: string): void {
    window.location.assign(url);
  },
};

export function fetchGoogleStatus(): Promise<GoogleStatus> {
  return apiFetch<GoogleStatus>('/api/google/status');
}

const TICKET_RE = /^[A-Za-z0-9._-]{1,256}$/;

/**
 * Inicia la conexion: pide un ticket de un solo uso con Bearer (apiFetch) y navega a
 * `/oauth/google/start` en la base del API ya validada (fail-closed). La navegacion top-level no
 * lleva el token: solo el ticket, que caduca en 60 s y no sirve dos veces.
 */
export async function startGoogleConnect(): Promise<void> {
  const { ticket } = await apiFetch<GoogleTicketResponse>('/api/oauth/google/ticket', {
    method: 'POST',
  });
  if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) {
    throw new ApiError(0, 'bad_ticket', 'Respuesta del servidor no valida.');
  }
  nav.go(`${getApiBase()}/oauth/google/start?ticket=${encodeURIComponent(ticket)}`);
}

export function disconnectGoogle(): Promise<{ ok: boolean; revoked: boolean }> {
  return apiFetch('/api/google/disconnect', { method: 'POST' });
}

export type GoogleResult = { ok: true } | { ok: false; reason: GoogleConnectReason | 'unknown' };

const REASONS = new Set<string>(GOOGLE_CONNECT_REASONS);

/**
 * Lee `?google=ok|error&reason=...` del hash y lo elimina de la URL e historial (replaceState),
 * para que no quede nada al recargar ni al compartir. null si no hay resultado.
 */
export function takeGoogleResult(): GoogleResult | null {
  const hash = window.location.hash;
  const i = hash.indexOf('?');
  if (i === -1) return null;
  const params = new URLSearchParams(hash.slice(i + 1));
  const google = params.get('google');
  if (google === null) return null;
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search}#/ajustes`);
  if (google === 'ok') return { ok: true };
  const reason = params.get('reason') ?? '';
  return { ok: false, reason: REASONS.has(reason) ? (reason as GoogleConnectReason) : 'unknown' };
}

export function connectErrorMessage(reason: GoogleConnectReason | 'unknown'): string {
  switch (reason) {
    case 'access_denied':
      return 'Has cancelado la conexión con Google.';
    case 'invalid_ticket':
    case 'invalid_state':
      return 'El enlace de conexión ha caducado o ya se usó. Vuelve a intentarlo.';
    case 'invalid_request':
    case 'exchange_failed':
      return 'Google no completó la conexión. Vuelve a intentarlo.';
    case 'missing_scope':
      return 'Necesitamos permiso para ver y editar eventos. Vuelve a conectar y deja marcadas todas las casillas.';
    case 'extra_scope':
      return 'Google concedió permisos distintos de los necesarios; por seguridad se han revocado. Vuelve a conectar.';
    case 'no_refresh_token':
      return 'Google no concedió acceso permanente. Quita el acceso de Organizador en tu cuenta de Google y vuelve a conectar.';
    case 'misconfigured':
      return 'El servidor todavía no tiene configurada la conexión con Google.';
    default:
      return 'Error inesperado al conectar con Google.';
  }
}

export function disconnectedMessage(reason: GoogleDisconnectReason | null): string {
  switch (reason) {
    case 'invalid_grant':
      return 'Google ha revocado o caducado el acceso. Vuelve a conectar.';
    case 'scope_mismatch':
      return 'Los permisos de Google ya no coinciden con los necesarios. Vuelve a conectar.';
    case 'unreadable':
      return 'No se pueden leer las credenciales guardadas de Google. Vuelve a conectar.';
    default:
      return 'Google Calendar no está conectado.';
  }
}

const SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/calendar.events': 'Ver y editar eventos',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly': 'Ver la lista de calendarios',
};

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

export function apiErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'misconfigured') return connectErrorMessage('misconfigured');
    if (e.code === 'network') return 'Error de conexión: no se pudo contactar con el servidor.';
    if (e.code === 'config') return 'La app no está configurada (falta la URL del servidor).';
    if (e.status === 429) return 'Demasiados intentos: espera unos minutos.';
    if (e.status > 0) return `Error del servidor (${e.status}).`;
  }
  return 'Error inesperado.';
}
