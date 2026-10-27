-- H0: Eventos marcados como hechos (D1, D2) + Alarmas en notas rapidas (B).

-- Eventos marcados como hechos (SOLO D1, nunca Google). Por instancia (id de Google de la instancia).
-- Sin FK a events (como event_meta): sobrevive a borrados/resync; si el evento vuelve, vuelve hecho.
CREATE TABLE event_done (
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  done_at TEXT NOT NULL,          -- ISO UTC del momento en que se marcó
  PRIMARY KEY (calendar_id, event_id)
) WITHOUT ROWID;

-- Alarma de nota rápida. remind_at NULL = sin alarma (y remind_state NULL).
ALTER TABLE notes ADD COLUMN remind_at TEXT;          -- ISO UTC
ALTER TABLE notes ADD COLUMN remind_state TEXT
  CHECK (remind_state IN ('pending','sent','gave_up'));
ALTER TABLE notes ADD COLUMN remind_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_notes_remind_due ON notes(remind_at) WHERE remind_state = 'pending';
