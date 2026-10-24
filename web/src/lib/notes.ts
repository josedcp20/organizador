import {
  addDaysToDateStr,
  formatDateInTz,
  isExpired,
  isValidExpiryDays,
  type NoteCreate,
  type NoteExpiryInput,
  type NoteInfo,
  type NotePatch,
  type NotesResponse,
  type QuickNoteCreate,
  type QuickNoteInfo,
} from '@organizador/shared';
import { ApiError, apiFetch } from './api';
import { CACHE_PREFIX, getToken } from './auth';

const CACHE_KEY = `${CACHE_PREFIX}notes`;

export function fetchNotes(): Promise<NotesResponse> {
  return apiFetch<NotesResponse>('/api/notes');
}

export function createNote(input: NoteCreate): Promise<NoteInfo> {
  return apiFetch<NoteInfo>('/api/notes', { method: 'POST', body: input });
}

export function patchNote(id: string, patch: NotePatch): Promise<NoteInfo> {
  return apiFetch<NoteInfo>(`/api/notes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function deleteNote(id: string): Promise<void> {
  return apiFetch<void>(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function createQuickNote(input: QuickNoteCreate): Promise<QuickNoteInfo> {
  return apiFetch<QuickNoteInfo>('/api/quick-notes', { method: 'POST', body: input });
}

/** Mensaje en espanol para errores de la API de notas. 401 devuelve '' (ya se cerro sesion). */
export function noteErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return '';
    if (e.code === 'network') return 'Sin conexión: no se pudo contactar con el servidor.';
    if (e.code === 'config') return 'La app no está configurada (falta la URL del servidor).';
    if (e.status === 404) return 'La nota ya no existe (puede haber caducado).';
    if (e.status === 400) return 'El servidor rechazó la nota. Revisa el texto y la caducidad.';
    if (e.status === 429) return 'Demasiados intentos: espera unos minutos.';
    if (e.status > 0) return `Error del servidor (${e.status}).`;
  }
  return 'Error inesperado.';
}

// --- Caducidad ------------------------------------------------------------------------------

export type ExpiryMode = 'keep' | 'forever' | 'today' | 'days';

export const NOTE_MAX_CHARS = 10000;

export function daysValid(days: number): boolean {
  return isValidExpiryDays(days);
}

/** Convierte la eleccion de la UI en `expiry` de la API; undefined = no cambiar. */
export function toExpiryInput(mode: ExpiryMode, days: number): NoteExpiryInput | undefined {
  if (mode === 'keep') return undefined;
  if (mode === 'forever') return { type: 'forever' };
  if (mode === 'today') return { type: 'today' };
  return { type: 'days', days };
}

const timeFmt = new Intl.DateTimeFormat('es-ES', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Madrid',
});

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Texto legible de caducidad. La API caduca siempre a las 00:00 (Europe/Madrid) de un dia:
 * si es la medianoche que cierra hoy -> "caduca hoy a las 00:00"; si no, "caduca en N dias".
 */
export function expiryLabel(expiresAt: string | null, nowMs: number = Date.now()): string {
  if (expiresAt === null) return 'sin caducidad';
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return 'sin caducidad';
  if (isExpired(expiresAt, nowMs)) return 'caducada';
  const today = formatDateInTz(new Date(nowMs));
  const lastDay = formatDateInTz(new Date(t - 1));
  if (lastDay <= today) return `caduca hoy a las ${timeFmt.format(new Date(t))}`;
  const n = dayDiff(today, addDaysToDateStr(lastDay, 1));
  return n === 1 ? 'caduca en 1 día' : `caduca en ${n} días`;
}

// --- Borrador de nota rapida (solo memoria del modulo, nunca storage) ----------------------

export const quickDraft = { text: '' };

// --- Orden y cache --------------------------------------------------------------------------

/** Fijadas primero; despues la mas recientemente modificada. */
export function sortNotes(notes: NoteInfo[]): NoteInfo[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export interface NotesCache {
  notes: NoteInfo[];
  savedAt: string;
}

export function saveNotesCache(notes: NoteInfo[]): void {
  // Sin sesion nunca se escribe cache (respuestas tardias tras cerrar sesion).
  if (!getToken()) return;
  try {
    const value: NotesCache = { notes, savedAt: new Date().toISOString() };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // sin almacenamiento: sin cache
  }
}

export function loadNotesCache(): NotesCache | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as NotesCache;
    if (!v || !Array.isArray(v.notes)) return null;
    return v;
  } catch {
    return null;
  }
}
