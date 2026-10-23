-- 0002: calendarios que desaparecen de Google se marcan (no se borran: events tiene FK con CASCADE).
ALTER TABLE calendars ADD COLUMN removed_at TEXT;  -- ISO UTC del import que no lo vio; NULL = presente en Google
