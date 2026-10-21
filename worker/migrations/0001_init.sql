-- 0001_init: esquema inicial (seccion 3 del plan). Sin watch_channels (fase 6) ni app_events.

-- Credenciales Google (una sola fila, id = 1)
CREATE TABLE google_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token_enc TEXT NOT NULL,      -- AES-GCM con TOKEN_ENC_KEY
  access_token TEXT,
  access_token_expires_at TEXT,
  scope TEXT,
  connected_at TEXT NOT NULL,
  last_error TEXT
);

-- Calendarios (desde calendarList) + color propio configurable
CREATE TABLE calendars (
  id TEXT PRIMARY KEY,                  -- Google calendarId
  summary TEXT NOT NULL,
  google_color TEXT,                    -- backgroundColor de Google
  color TEXT,                           -- override del usuario (#RRGGBB); NULL = usar google_color
  enabled INTEGER NOT NULL DEFAULT 1,   -- mostrar/sincronizar
  access_role TEXT,                     -- owner | writer | reader | freeBusyReader (calendarList.accessRole)
                                        -- writable = access_role IN ('owner','writer'); se refresca en cada import
  sync_token TEXT,
  last_synced_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Eventos espejo de Google (bidireccional, D10): el sync escribe aqui lo que viene de Google y
-- las escrituras de la app actualizan la fila de forma optimista tras llamar a Google.
-- Solo contiene CAMPOS DEL EVENTO (los que existen en Google); nada privado.
-- Ventana de sync: [hoy - 1 mes, hoy + 12 meses] (D6). Las filas con inicio anterior
-- a la ventana se conservan y quedan congeladas (el sync no las actualiza ni borra; la app no
-- permite editarlas ni borrarlas: decision cerrada).
CREATE TABLE events (
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                     -- Google event id (instancia si singleEvents)
  recurring_event_id TEXT,
  status TEXT NOT NULL,                 -- confirmed | tentative | cancelled
  summary TEXT,
  location TEXT,
  description TEXT,
  all_day INTEGER NOT NULL,
  start_at TEXT, end_at TEXT,           -- eventos con hora (UTC)
  start_date TEXT, end_date TEXT,       -- eventos de dia completo
  html_link TEXT,
  updated TEXT,
  etag TEXT,                            -- etag de Google; se envia como If-Match al editar/borrar
  original_start TEXT,                  -- originalStartTime de la instancia (recurrentes)
  origin TEXT NOT NULL DEFAULT 'google' CHECK (origin IN ('google','app')),
                                        -- 'app' = creado desde la app (id determinista o
                                        -- extendedProperties.private.organizadorId presente)
  local_id TEXT,                        -- organizadorId (uuid) si origin = 'app'
  pending_op TEXT CHECK (pending_op IN ('insert','patch','delete')), -- NULL = sincronizado
  pending_payload TEXT,                 -- JSON del payload YA filtrado por toGooglePayload (solo campos de evento)
  pending_scope TEXT CHECK (pending_scope IN ('instance','series')),
  pending_attempts INTEGER NOT NULL DEFAULT 0,
  pending_since TEXT,
  write_error TEXT,                     -- motivo legible del ultimo fallo de escritura ('forbidden', 'conflict', ...)
  PRIMARY KEY (calendar_id, id)
);
CREATE INDEX idx_events_start ON events(start_at);
CREATE INDEX idx_events_start_date ON events(start_date);
CREATE UNIQUE INDEX idx_events_local_id ON events(local_id) WHERE local_id IS NOT NULL;
CREATE INDEX idx_events_pending ON events(pending_op) WHERE pending_op IS NOT NULL;
-- Eventos creados en la app: id de Google = uuid v4 sin guiones (32 chars hex, valido en base32hex)
-- generado por el Worker a partir de `client_id` (idempotencia). Reintentar un insert con el mismo id
-- devuelve 409 duplicate -> se trata como exito (events.get). Asi el evento que vuelve por el sync
-- cae en la misma fila (calendar_id, id) y no se duplica. Tabla `app_events` ELIMINADA (antes T3.7):
-- no hay eventos solo locales en v1. Las filas con pending_op las respeta el sync (ver seccion 6).

-- Datos propios por evento (NUNCA van a Google). D3: ambito por instancia o por serie.
CREATE TABLE event_meta (
  calendar_id TEXT NOT NULL,            -- calendarId de Google
  scope TEXT NOT NULL CHECK (scope IN ('instance','series')),
  target_id TEXT NOT NULL,              -- instance: event id (instancia); series: recurring_event_id
  notes TEXT,                           -- NULL = no definido en este ambito (hereda)
  remind INTEGER,                       -- casilla "avisar": 1/0; NULL = hereda
  remind_days_before INTEGER CHECK (remind_days_before BETWEEN 1 AND 60), -- NULL = hereda; defecto efectivo 5
  color TEXT,                           -- #RRGGBB override por evento (nunca colorId de Google); NULL = hereda
  updated_at TEXT NOT NULL,
  PRIMARY KEY (calendar_id, scope, target_id)
);
-- Resolucion al mostrar (db/eventMeta.ts), campo a campo: instancia (si no NULL) > serie (si no NULL) > defecto
-- (notes vacio, remind 0, remind_days_before 5). Guardar con ambito "serie" no borra overrides de instancia;
-- la UI avisa si existen y ofrece "quitar personalizacion de esta instancia".
-- Eventos no recurrentes (incluidos todos los creados en la app, v1 sin recurrencia) solo admiten scope 'instance'.
-- Sin FK a events: si Google borra el evento la nota se conserva (huerfana visible en Ajustes).
-- Si el usuario borra el evento DESDE la app, su meta de instancia se borra tambien (la de serie solo si borra la serie).
-- Color efectivo de un evento: event_meta.color > (origin='app' ? settings.app_events_color : calendars.color) > google_color.

-- Registro de avisos D-N enviados (por instancia concreta, aunque el flag venga de la serie)
CREATE TABLE reminder_log (
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,               -- id de instancia
  start_key TEXT NOT NULL,              -- fecha/hora de inicio avisada (si el evento se mueve, cambia y se re-avisa)
  status TEXT NOT NULL,                 -- 'sent' | 'failed' | 'gave_up'
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (calendar_id, event_id, start_key)
);

-- Estado del resumen diario (D4): idempotencia, reintentos y motivo de fallo para banner/Ajustes
CREATE TABLE digest_log (
  date TEXT PRIMARY KEY,                -- YYYY-MM-DD Madrid
  status TEXT NOT NULL,                 -- 'pending' | 'sent' | 'failed' | 'gave_up' | 'no_subscriptions'
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,                      -- motivo legible (sin datos sensibles)
  last_attempt_at TEXT,
  sent_at TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0 -- el usuario cerro el banner
);

-- Intentos fallidos de autenticacion por IP (D1 seguridad)
CREATE TABLE auth_failures (
  ip TEXT PRIMARY KEY,                  -- HMAC-SHA256 (32 hex) de la IPv4 o del /64 IPv6, con clave derivada de APP_TOKEN_SHA256; no se guarda la IP
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL,
  blocked_until TEXT
) WITHOUT ROWID;                         -- sin indice aparte de la PK: 1 escritura por fallo

-- Preferencias simples clave/valor ('app_events_color', 'default_write_calendar')
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Notas (seccion de notas + notas rapidas)
CREATE TABLE notes (
  id TEXT PRIMARY KEY,                  -- uuid
  body TEXT NOT NULL,
  title TEXT,
  kind TEXT NOT NULL DEFAULT 'note',    -- 'note' | 'quick'
  pinned INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,                      -- NULL = siempre
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_notes_expires ON notes(expires_at);

-- Suscripciones Web Push (iPhone PWA, PC, ...)
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_label TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0
);

-- Estado de jobs (idempotencia del cron)
CREATE TABLE job_state (
  key TEXT PRIMARY KEY,                 -- 'sync_cursor', 'sync_window_start', ...
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
