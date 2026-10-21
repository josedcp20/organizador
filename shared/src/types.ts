/**
 * Tipos compartidos del proyecto Organizador
 */

/**
 * Representación de un evento
 */
export interface Event {
  id: string;
  summary: string;
  description?: string;
  startAt?: string; // ISO-8601 UTC
  endAt?: string; // ISO-8601 UTC
  allDay?: boolean;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
}

/**
 * Representación de un calendario
 */
export interface Calendar {
  id: string;
  summary: string;
  color?: string;
  enabled: boolean;
}

/**
 * Representación de una nota
 */
export interface Note {
  id: string;
  title?: string;
  body: string;
  kind: 'note' | 'quick';
  pinned: boolean;
  expiresAt?: string; // ISO-8601 UTC
  createdAt: string;
  updatedAt: string;
}

/**
 * Payload del widget "hoy"
 */
export interface TodayPayload {
  events: Event[];
  notes: Note[];
}
