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
 * Motivos (lista cerrada) con los que el Worker vuelve a la app tras el flujo OAuth:
 * `APP_URL#/ajustes?google=error&reason=<motivo>`. Nunca contienen datos sensibles.
 */
export const GOOGLE_CONNECT_REASONS = [
  'access_denied', // el usuario cancelo en Google
  'invalid_ticket', // ticket de /start invalido, caducado o ya usado
  'invalid_state', // state invalido, caducado o ya usado
  'invalid_request', // falta `code` u otro parametro
  'exchange_failed', // Google rechazo el intercambio del code
  'missing_scope', // falta un permiso obligatorio (p. ej. calendar.events)
  'extra_scope', // se concedio un permiso de mas: se revoca y se rechaza
  'no_refresh_token', // Google no devolvio refresh token
  'misconfigured', // faltan secretos/variables en el Worker
  'internal', // error interno
] as const;

export type GoogleConnectReason = (typeof GOOGLE_CONNECT_REASONS)[number];

/** Motivo por el que la conexion con Google esta caida (estado visible en Ajustes / banner). */
export type GoogleDisconnectReason =
  | 'not_connected'
  | 'invalid_grant'
  | 'scope_mismatch'
  // No se pueden descifrar las credenciales (TOKEN_ENC_KEY cambiada o fila manipulada): reconectar.
  | 'unreadable';

/** `GET /api/google/status` */
export interface GoogleStatus {
  /** true si el Worker tiene client id/secret y claves cargados (si no, no se puede conectar). */
  configured: boolean;
  connected: boolean;
  /** null si esta conectado. */
  reason: GoogleDisconnectReason | null;
  /** Scopes concedidos (vacio si no hay conexion). */
  scopes: string[];
  connectedAt: string | null;
  /** Ultimo error (codigo corto, sin datos sensibles) o null. */
  lastError: string | null;
}

/** `POST /api/oauth/google/ticket` */
export interface GoogleTicketResponse {
  ticket: string;
  /** Segundos de vida del ticket. */
  expiresIn: number;
}

/**
 * Payload del widget "hoy"
 */
export interface TodayPayload {
  events: Event[];
  notes: Note[];
}

/**
 * Paleta fija de la app para calendarios (colores PROPIOS, distintos de los de Google).
 * Los calendarios nuevos reciben el siguiente libre; el usuario puede elegir otro o uno personalizado.
 */
export const CALENDAR_PALETTE = [
  '#1a73e8', // azul
  '#d93025', // rojo
  '#188038', // verde
  '#f9ab00', // ambar
  '#8e24aa', // violeta
  '#00897b', // turquesa
  '#e8710a', // naranja
  '#c2185b', // rosa
  '#5d4037', // marron
  '#546e7a', // gris azulado
] as const;

/** `#rrggbb` estricto (6 digitos hex, con almohadilla). */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

/** Calendario tal y como lo ve la app (`GET /api/calendars`). */
export interface CalendarInfo {
  /** calendarId de Google. */
  id: string;
  name: string;
  /** Color propio de la app (#rrggbb). Nunca se envia a Google. */
  color: string;
  /** Interruptor "visible/sincronizar" (solo en la app). */
  visible: boolean;
  /** owner | writer | reader | freeBusyReader (null si Google no lo informo). */
  accessRole: string | null;
  /** true solo para owner/writer. */
  writable: boolean;
  /** Fin (ISO UTC) de la ultima sincronizacion correcta, o null si nunca. */
  lastSyncedAt: string | null;
  /** Ultimo error de sync (codigo corto, sin datos sensibles) o null. */
  lastSyncError: string | null;
}

/** `GET /api/calendars` y `POST /api/calendars/refresh` */
export interface CalendarsResponse {
  calendars: CalendarInfo[];
}

/** Body de `PATCH /api/calendars/:id` (solo estos campos; cualquier otro se rechaza). */
export interface CalendarPatch {
  color?: string;
  visible?: boolean;
}

/**
 * Resultado de una pasada de sincronizacion Google -> D1 (`POST /api/sync`). Solo contadores y
 * codigos: nunca ids de calendario ni datos de eventos.
 */
export interface SyncResult {
  /** ok = se intento sincronizar; el resto = no se pudo empezar (sin llamadas a Calendar API). */
  status: 'ok' | 'busy' | 'not_connected' | 'misconfigured' | 'unavailable' | 'auth_rejected';
  /** Calendarios candidatos (visibles, presentes en Google, sin backoff activo). */
  calendars: number;
  /** Terminaron la pasada (incremental o completa) en esta ejecucion. */
  completed: number;
  /** Quedaron a medias por presupuesto (se reanudan en la siguiente ejecucion). */
  partial: number;
  /** Fallaron (motivo por calendario en D1: calendars.last_sync_error). */
  failed: number;
  /** Peticiones hechas a Calendar API. */
  requests: number;
  upserted: number;
  deleted: number;
}

/** Evento tal y como lo ve la app (`GET /api/agenda`, `GET /api/today`). Siempre leido de D1. */
export interface EventInfo {
  /** Id de Google del evento (instancia si es recurrente). */
  id: string;
  calendarId: string;
  /**
   * Color efectivo (#rrggbb): color propio del evento > (origin='app' ? color de eventos de la app :
   * color del calendario) > color de Google.
   */
  color: string;
  status: 'confirmed' | 'tentative';
  summary: string | null;
  location: string | null;
  description: string | null;
  allDay: boolean;
  /** ISO UTC; solo eventos con hora. */
  startAt: string | null;
  endAt: string | null;
  /** YYYY-MM-DD; solo eventos de dia completo. `endDate` es EXCLUSIVO (como en Google). */
  startDate: string | null;
  endDate: string | null;
  recurringEventId: string | null;
  htmlLink: string | null;
  origin: 'google' | 'app';
  /** Datos locales (event_meta, instancia > serie > defecto). Nunca van a Google. */
  notes: string;
  remind: boolean;
  remindDaysBefore: number;
  /** El calendario permite escribir (accessRole owner/writer). */
  writable: boolean;
  /** Inicio anterior a la ventana de sync (hoy - 1 mes, Madrid): el sync ya no lo actualiza. */
  frozen: boolean;
  /** Escritura a Google sin confirmar (con el ultimo error, si lo hubo); null si esta sincronizado. */
  pending: EventPending | null;
}

export interface EventPending {
  op: 'insert' | 'patch' | 'delete';
  error: string | null;
}

/** `GET /api/agenda?from=YYYY-MM-DD&to=YYYY-MM-DD` (rango inclusivo, fechas de Europe/Madrid). */
export interface EventsResponse {
  from: string;
  to: string;
  events: EventInfo[];
}

/** `GET /api/today`: hoy y manana (Europe/Madrid). Un evento multi-dia aparece en cada dia que toca. */
export interface TodayResponse {
  today: string;
  tomorrow: string;
  todayEvents: EventInfo[];
  tomorrowEvents: EventInfo[];
}
