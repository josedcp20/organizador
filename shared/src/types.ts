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
  /**
   * Valores guardados en cada ambito (sin resolver), para que la UI sepa que esta personalizado en
   * la instancia y que hereda de la serie. null = no hay fila en ese ambito. El Worker siempre lo
   * rellena; es opcional solo para no obligar a los mocks de la UI.
   */
  metaScopes?: EventMetaScopes;
  /** Marcado como hecho (D1, solo en la app). null = no marcado. */
  done?: boolean;
}

/** Ambito de los datos privados de un evento: la instancia concreta o toda la serie recurrente. */
export type EventMetaScope = 'instance' | 'series';

/** Valores de un ambito de `event_meta`. null = no definido en ese ambito (hereda). Nunca van a Google. */
export interface EventMetaValues {
  notes: string | null;
  remind: boolean | null;
  remindDaysBefore: number | null;
  /** #rrggbb */
  color: string | null;
}

export interface EventMetaScopes {
  instance: EventMetaValues | null;
  /** Siempre null en eventos no recurrentes. */
  series: EventMetaValues | null;
}

/** Limites de los datos privados de evento (validados en el Worker; la UI puede reutilizarlos). */
export const EVENT_META_LIMITS = {
  notesMaxLength: 10_000,
  remindDaysMin: 1,
  remindDaysMax: 60,
  remindDaysDefault: 5,
} as const;

/**
 * Body de `PUT /api/agenda/:calendarId/:eventId/meta`. Parcial: un campo ausente no cambia; un campo
 * a null deja de estar definido en ese ambito (vuelve a heredar). `scope='series'` solo en eventos
 * recurrentes. Responde con el `EventInfo` resuelto. Solo D1: nunca se envia a Google.
 */
export interface EventMetaInput {
  scope: EventMetaScope;
  notes?: string | null;
  remind?: boolean | null;
  /** Entero 1..60. */
  remind_days_before?: number | null;
  /** #rrggbb */
  color?: string | null;
}

/**
 * Body de `PUT /api/agenda/:calendarId/:eventId/done` (D1, D2). Marca o desmarca un evento
 * como hecho. Responde con el `EventInfo` actualizado. Idempotente.
 */
export interface EventDoneInput {
  done: boolean;
}

export interface EventPending {
  op: 'insert' | 'patch' | 'delete';
  error: string | null;
}

// --- Escritura de eventos en Google (T3.7) ---

/** Limites de los campos de evento que se escriben en Google (los valida el Worker). */
export const AGENDA_WRITE_LIMITS = {
  summaryMax: 1024,
  locationMax: 1024,
  descriptionMax: 8192,
  /** `client_id`: [A-Za-z0-9-], 1..64 (recomendado: crypto.randomUUID()). */
  clientIdMax: 64,
} as const;

/**
 * Body de `POST /api/agenda` (crea un evento NO recurrente en Google). Solo campos de Google: las
 * notas privadas, avisos y color van aparte (`PUT .../meta`), nunca aqui (cualquier otra clave -> 400).
 * - `allDay: true`: `start`/`end` = YYYY-MM-DD y `end` EXCLUSIVO (> start; un dia: end = start + 1).
 * - `allDay: false`: `start`/`end` = ISO con desfase (`2026-11-02T09:00:00Z`, `...+01:00`) o hora
 *   local de Europe/Madrid sin desfase (`2026-11-02T10:00`); `end >= start`.
 * - `client_id`: idempotencia. Repetir el POST con el mismo `client_id` no duplica (mismo id de Google).
 */
export interface AgendaEventCreate {
  client_id: string;
  calendarId: string;
  summary: string;
  location?: string | null;
  /** Descripcion PUBLICA (se guarda en Google). */
  description?: string | null;
  allDay: boolean;
  start: string;
  end: string;
}

/**
 * Body de `PATCH /api/agenda/:calendarId/:eventId` (solo eventos no recurrentes). Parcial: ausente =
 * no cambia; `null`/'' en location/description = vaciar. Fechas: `allDay`, `start` y `end` van JUNTOS
 * (mismo formato que en el alta); no se puede cambiar entre dia completo y con hora (400).
 * `confirm_external: true` obligatorio si `origin === 'google'` (si no, 428 sin llamar a Google).
 */
export interface AgendaEventPatch {
  summary?: string;
  location?: string | null;
  description?: string | null;
  allDay?: boolean;
  start?: string;
  end?: string;
  confirm_external?: boolean;
}

/**
 * Codigos de error de las escrituras de eventos (`{ error: { code, message } }`):
 * - 400 `validation`; 400 `google_rejected` (Google rechazo los datos)
 * - 403 `calendar_forbidden` (calendario sin permiso de escritura: no se llama a Google, o Google 403)
 * - 404 `not_found` (no esta en D1, o Google ya no lo tiene al editar)
 * - 409 `conflict` (el evento cambio en Google: el cuerpo incluye `current`, ya aplicado en D1)
 * - 409 `write_pending` (hay una escritura sin confirmar que lo impide; reintentar/descartar)
 * - 409 `duplicate` (`client_id` ya usado para otro evento/calendario); 410 `gone` (ese evento se borro)
 * - 409 `google_not_connected`; 423 `frozen`; 428 `confirmation_required`
 * - 501 `recurring_not_supported` (eventos recurrentes: T3.9); 500 `misconfigured`; 502 `google_error`
 * Exito: 201 (creado) / 200 (POST repetido ya confirmado, o PATCH) con `EventInfo`; 204 (DELETE);
 * 202 con `EventInfo` (`pending` != null) si Google fallo de forma transitoria y queda en cola.
 */
export type AgendaWriteErrorCode =
  | 'validation'
  | 'google_rejected'
  | 'calendar_forbidden'
  | 'not_found'
  | 'conflict'
  | 'write_pending'
  | 'duplicate'
  | 'gone'
  | 'google_not_connected'
  | 'frozen'
  | 'confirmation_required'
  | 'recurring_not_supported'
  | 'misconfigured'
  | 'google_error';

/** Cuerpo del 409 `conflict`: version actual de Google (ya guardada en D1); null si no es visible. */
export interface AgendaConflictBody {
  error: { code: 'conflict'; message: string };
  current: EventInfo | null;
}

/** `GET /api/settings` y respuesta de `PATCH /api/settings`. Solo D1: nunca va a Google. */
export interface AppSettings {
  /** Color (#rrggbb) de los eventos creados en la app; null = el del calendario. */
  app_events_color: string | null;
  /** Calendario preseleccionado al crear (writable y presente); null = ninguno. */
  default_write_calendar: string | null;
}

/** Body de `PATCH /api/settings`: parcial; null borra el ajuste; otra clave -> 400. */
export type AppSettingsPatch = Partial<AppSettings>;

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
  /** Avisos D-N vigentes (Fase 4, T4.5). */
  reminders?: ReminderAlert[];
  /** Resumen de hoy fallido/abandonado y no cerrado por el usuario (Fase 4, T4.4). */
  digestAlert?: DigestAlert | null;
}

// --- Notas y notas rapidas (T3.2) ---

/** Longitud maxima del cuerpo de una nota. */
export const NOTE_BODY_MAX = 10000;
/** Longitud maxima del titulo de una nota. */
export const NOTE_TITLE_MAX = 200;

export type NoteKind = 'note' | 'quick';

/** Paso de granularidad para alarmas (minutos): remind_at solo admite multiplos de este valor. */
export const ALARM_STEP_MIN = 10;

/** Texto fijo del push de alarma de nota rápida. */
export const ALARM_PUSH_TEXT = 'NOTA!!!!!';

/** Limites y configuracion de alarmas en notas rapidas. */
export const NOTE_ALARM_LIMITS = {
  maxAheadDays: 365,
  pastToleranceMs: 60_000,
  retryWindowMs: 6 * 3_600_000,
  maxAttempts: 10,
  perRun: 3,
  keepAfterMs: 24 * 3_600_000,
} as const;

/** Caducidad pedida por el cliente (ver `computeExpiresAt` en time.ts). */
export type NoteExpiryInput =
  { type: 'today' } | { type: 'days'; days: number } | { type: 'forever' };

/** Nota tal como la devuelve la API. `expiresAt` null = sin caducidad. Nunca se envia a Google. */
export interface NoteInfo {
  id: string;
  kind: NoteKind;
  title: string | null;
  body: string;
  pinned: boolean;
  expiresAt: string | null; // ISO-8601 UTC
  createdAt: string;
  updatedAt: string;
  /** Alarma (solo en notas rapidas). ISO-8601 UTC; null = sin alarma. */
  remindAt?: string | null;
  /** Estado de la alarma. null si no hay alarma. */
  remindState?: 'pending' | 'sent' | 'gave_up' | null;
}

export interface NotesResponse {
  notes: NoteInfo[];
}

export interface NoteCreate {
  body: string;
  title?: string | null;
  kind?: NoteKind; // defecto 'note'
  pinned?: boolean;
  expiry?: NoteExpiryInput; // defecto: forever
}

export interface NotePatch {
  body?: string;
  title?: string | null;
  pinned?: boolean;
  expiry?: NoteExpiryInput; // recalcula desde el instante de la edicion
  /** Alarma de nota rapida (solo en notas rapidas). null = quitar alarma. */
  remind_at?: string | null;
}

/** Nota rapida (kind = 'quick'). */
export interface QuickNoteInfo {
  id: string;
  body: string;
  expiresAt: string | null;
  createdAt: string;
  /** Alarma. ISO-8601 UTC; null = sin alarma. */
  remindAt?: string | null;
  /** Estado de la alarma. null si no hay alarma. */
  remindState?: 'pending' | 'sent' | 'gave_up' | null;
}

export interface QuickNotesResponse {
  quickNotes: QuickNoteInfo[];
}

export interface QuickNoteCreate {
  body: string;
  expiry?: NoteExpiryInput; // defecto: today
  /** Alarma. ISO-8601 UTC con offset o hora local de Europe/Madrid. null = sin alarma. */
  remind_at?: string | null;
}

// --- Autenticacion con passkeys (WebAuthn, Face ID en iOS)

/** Tipo de autenticacion en una sesion. */
export type AuthKind = 'static' | 'session';

/** Informacion de una passkey registrada (nunca expone la clave publica). */
export interface PasskeyInfo {
  /** credential id (base64url) */
  id: string;
  label: string;
  createdAt: string; // ISO-8601 UTC
  lastUsedAt: string | null; // ISO-8601 UTC
  backedUp: boolean;
}

/** `GET /api/passkeys` */
export interface PasskeysResponse {
  passkeys: PasskeyInfo[];
}

/** `POST /api/passkeys/login`: resultado de un login exitoso con passkey. */
export interface PasskeyLoginResult {
  token: string; // s1.<base64url>
  expiresAt: string; // ISO-8601 UTC
}

/** Body de `POST /api/passkeys/register`. */
export interface PasskeyRegisterBody {
  response: RegistrationResponseJSON;
  label?: string; // <= 60 chars, default "iPhone"
}

/**
 * Respuesta de `navigator.credentials.create()` serializada a JSON.
 * Forma minima compatible con @simplewebauthn/server.
 */
export interface RegistrationResponseJSON {
  id: string; // credential id (base64url)
  rawId: string; // idem (redundancia JSON)
  response: {
    clientDataJSON: string; // base64url
    attestationObject: string; // base64url
    transports?: ('internal' | 'hybrid')[];
  };
  type: 'public-key';
}

/**
 * Respuesta de `navigator.credentials.get()` serializada a JSON.
 * Forma minima compatible con @simplewebauthn/server.
 */
export interface AuthenticationResponseJSON {
  id: string; // credential id (base64url)
  rawId: string; // idem (redundancia JSON)
  response: {
    clientDataJSON: string; // base64url
    authenticatorData: string; // base64url
    signature: string; // base64url
    userHandle?: string; // base64url o null
  };
  type: 'public-key';
}

/** `GET /api/me`: respuesta actualizada con autenticacion. */
export interface MeResponse {
  ok: boolean;
  version: string;
  tz: string;
  /** Tipo de autenticacion activa */
  auth: AuthKind;
  /** Caducidad de la sesion actual (si `auth === 'session'`) */
  sessionExpiresAt?: string; // ISO-8601 UTC
}

/** Limites y tiempos de vida relacionados con passkeys. */
export const PASSKEY_LIMITS = {
  /** Longitud maxima del label de una passkey. */
  labelMax: 60,
  /** Numero maximo de passkeys registradas. */
  maxPasskeys: 10,
  /** Vida del challenge (segundos). */
  challengeTtlSeconds: 300, // 5 min
  /** Vida de una sesion Face ID (segundos, D-FID1). */
  sessionTtlSeconds: 30 * 24 * 60 * 60, // 30 dias
  /** Vida del nonce consumido (segundos, debe ser > challengeTtlSeconds). */
  consumedNonceTtlSeconds: 600, // 10 min
} as const;

// --- Web Push (Fase 4)

/** Estado del resumen diario en `digest_log`. */
export type DigestStatus = 'pending' | 'sent' | 'failed' | 'gave_up' | 'no_subscriptions';

/** Resumen de un dia (`digest_log`). */
export interface DigestInfo {
  date: string; // YYYY-MM-DD Europe/Madrid
  status: DigestStatus;
  attempts: number;
  lastError: string | null;
  sentAt: string | null; // ISO-8601 UTC
}

/** Banner de Hoy cuando el resumen de hoy no llego. */
export interface DigestAlert {
  date: string;
  status: 'failed' | 'gave_up';
  lastError: string | null;
}

/** Aviso D-N de un evento marcado con "Avisar". */
export interface ReminderAlert {
  calendarId: string;
  id: string;
  summary: string;
  date: string; // YYYY-MM-DD de inicio
  inDays: number; // 1..remindDaysBefore
}

/** Dispositivo suscrito (nunca expone endpoint ni claves). */
export interface PushSubscriptionInfo {
  /** 16 hex de SHA-256(endpoint) */
  id: string;
  label: string;
  createdAt: string;
  lastOkAt: string | null;
  failCount: number;
  lastError: string | null;
}

/** `GET /api/push/status` */
export interface PushStatusResponse {
  /** false si falta o es invalido VAPID_PRIVATE_KEY. */
  configured: boolean;
  /** applicationServerKey (base64url, 65 bytes) o null si no esta configurado. */
  publicKey: string | null;
  subject: string;
  subscriptions: PushSubscriptionInfo[];
  digest: DigestInfo | null;
}

/** `POST /api/push/subscribe` -> 200 */
export interface PushSubscribeResult {
  id: string;
}

/** `POST /api/push/test` -> 200 */
export interface PushTestResult {
  sent: number;
  failed: number;
  removed: number;
}

export const PUSH_LIMITS = {
  /** U9: al superar el maximo se expulsa la mas antigua. */
  maxSubscriptions: 5,
  /** Intervalo minimo entre `POST /api/push/test`. */
  testIntervalMs: 30_000,
  /** Longitud maxima del cuerpo de la notificacion del resumen. */
  bodyMax: 180,
} as const;
