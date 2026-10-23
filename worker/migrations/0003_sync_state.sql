-- 0003: estado del motor de sync Google -> D1 (T2.4). Ver worker/src/sync/engine.ts.

-- Cursor de una pasada EN CURSO (JSON: fase full|incremental, pageToken, ventana y run de la
-- pasada completa). NULL = no hay pasada a medias. Se guarda en el mismo batch que los eventos de
-- cada pagina, asi que una ejecucion cortada se reanuda desde la ultima pagina confirmada.
ALTER TABLE calendars ADD COLUMN sync_cursor TEXT;
-- Inicio (ISO UTC) de la ultima pasada COMPLETA terminada. Resync completo diario (D7): si su dia
-- (Madrid) no es hoy, la siguiente pasada es completa (capta lo que entra en el horizonte +12 meses).
ALTER TABLE calendars ADD COLUMN last_full_sync_at TEXT;
-- Ultimo error de sync (codigo corto, sin datos sensibles: rate_limited, forbidden, not_found,
-- google_5xx, network, bad_response, internal...) para Ajustes. NULL tras un sync correcto.
ALTER TABLE calendars ADD COLUMN last_sync_error TEXT;
ALTER TABLE calendars ADD COLUMN last_sync_error_at TEXT;
-- Fallos consecutivos y backoff exponencial (no se reintenta antes de sync_backoff_until).
ALTER TABLE calendars ADD COLUMN sync_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calendars ADD COLUMN sync_backoff_until TEXT;

-- Run (ISO de inicio) de la ultima pasada completa que vio el evento en Google. Al terminar una
-- pasada completa, las filas DENTRO de la ventana no vistas en ese run (y no modificadas despues de
-- su inicio, ni pendientes de escritura) se borran: eran eventos borrados en Google cuyo
-- "cancelled" ya no llega. NULL = solo visto por sync incremental o escrito por la app.
ALTER TABLE events ADD COLUMN sync_run TEXT;
