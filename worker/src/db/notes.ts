import {
  NOTE_ALARM_LIMITS,
  type NoteInfo,
  type NoteKind,
  type QuickNoteInfo,
} from '@organizador/shared';

/** Fila de `notes`. Las notas NUNCA se envian a Google: solo viven en D1. */
interface NoteRow {
  id: string;
  body: string;
  title: string | null;
  kind: string;
  pinned: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  remind_at: string | null;
  remind_state: 'pending' | 'sent' | 'gave_up' | null;
}

const COLS =
  'id, body, title, kind, pinned, expires_at, created_at, updated_at, remind_at, remind_state';
/** Vigente = sin caducidad o con caducidad estrictamente futura. Las caducadas nunca salen de aqui. */
const LIVE = '(expires_at IS NULL OR expires_at > ?)';

function toInfo(r: NoteRow): NoteInfo {
  return {
    id: r.id,
    kind: r.kind === 'quick' ? 'quick' : 'note',
    title: r.title,
    body: r.body,
    pinned: r.pinned === 1,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // Solo con alarma: sin ella la forma de la respuesta no cambia.
    ...(r.remind_at ? { remindAt: r.remind_at, remindState: r.remind_state } : {}),
  };
}

export function toQuickInfo(n: NoteInfo): QuickNoteInfo {
  return {
    id: n.id,
    body: n.body,
    expiresAt: n.expiresAt,
    createdAt: n.createdAt,
    ...(n.remindAt ? { remindAt: n.remindAt, remindState: n.remindState } : {}),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Notas vigentes: fijadas primero, luego las mas recientes. */
export async function listLiveNotes(
  db: D1Database,
  nowMs: number,
  kind?: NoteKind,
): Promise<NoteInfo[]> {
  const where = kind ? `${LIVE} AND kind = ?` : LIVE;
  const binds: unknown[] = kind ? [iso(nowMs), kind] : [iso(nowMs)];
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM notes WHERE ${where} ORDER BY pinned DESC, created_at DESC, id LIMIT 1000`,
    )
    .bind(...binds)
    .all<NoteRow>();
  return results.map(toInfo);
}

export async function getLiveNote(
  db: D1Database,
  id: string,
  nowMs: number,
  kind?: NoteKind,
): Promise<NoteInfo | null> {
  const where = kind ? `id = ? AND ${LIVE} AND kind = ?` : `id = ? AND ${LIVE}`;
  const binds: unknown[] = kind ? [id, iso(nowMs), kind] : [id, iso(nowMs)];
  const r = await db
    .prepare(`SELECT ${COLS} FROM notes WHERE ${where}`)
    .bind(...binds)
    .first<NoteRow>();
  return r ? toInfo(r) : null;
}

export interface NewNote {
  body: string;
  title: string | null;
  kind: NoteKind;
  pinned: boolean;
  expiresAt: string | null;
  /** ISO UTC (solo kind quick); la validacion vive en la ruta. */
  remindAt?: string | null;
}

/** SQL: la nota con alarma pendiente no caduca antes de alarma + keepAfterMs (formato = toISOString). */
const CLAMP_SQL = `UPDATE notes SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', remind_at, '+${NOTE_ALARM_LIMITS.keepAfterMs / 3_600_000} hours')
  WHERE id = ? AND remind_state = 'pending' AND expires_at > ?
    AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', remind_at, '+${NOTE_ALARM_LIMITS.keepAfterMs / 3_600_000} hours')`;

export async function insertNote(db: D1Database, n: NewNote, nowMs: number): Promise<NoteInfo> {
  const id = crypto.randomUUID();
  const ts = iso(nowMs);
  const remindAt = n.remindAt ?? null;
  await db.batch([
    db
      .prepare(
        `INSERT INTO notes (id, body, title, kind, pinned, expires_at, created_at, updated_at, remind_at, remind_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        n.body,
        n.title,
        n.kind,
        n.pinned ? 1 : 0,
        n.expiresAt,
        ts,
        ts,
        remindAt,
        remindAt ? 'pending' : null,
      ),
    db.prepare(CLAMP_SQL).bind(id, ts),
  ]);
  const row = await db.prepare(`SELECT ${COLS} FROM notes WHERE id = ?`).bind(id).first<NoteRow>();
  return toInfo(row as NoteRow);
}

export interface NoteChanges {
  body?: string;
  title?: string | null;
  pinned?: boolean;
  /** undefined = no tocar; null = sin caducidad. */
  expiresAt?: string | null;
  /** undefined = no tocar; null = quitar alarma; ISO = fijar (pending, attempts 0). */
  remindAt?: string | null;
}

/** Actualiza solo una nota vigente. Devuelve false si no existe o ya caduco. */
export async function updateLiveNote(
  db: D1Database,
  id: string,
  ch: NoteChanges,
  nowMs: number,
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (ch.body !== undefined) {
    sets.push('body = ?');
    binds.push(ch.body);
  }
  if (ch.title !== undefined) {
    sets.push('title = ?');
    binds.push(ch.title);
  }
  if (ch.pinned !== undefined) {
    sets.push('pinned = ?');
    binds.push(ch.pinned ? 1 : 0);
  }
  if (ch.expiresAt !== undefined) {
    sets.push('expires_at = ?');
    binds.push(ch.expiresAt);
  }
  if (ch.remindAt !== undefined) {
    sets.push('remind_at = ?', 'remind_state = ?', 'remind_attempts = 0');
    binds.push(ch.remindAt, ch.remindAt ? 'pending' : null);
  }
  sets.push('updated_at = ?');
  binds.push(iso(nowMs), id, iso(nowMs));
  // Mismo batch: el clamp se reaplica tras cualquier edicion (alarma o caducidad nuevas).
  const [r] = await db.batch([
    db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND ${LIVE}`).bind(...binds),
    db.prepare(CLAMP_SQL).bind(id, iso(nowMs)),
  ]);
  return (r.meta.changes ?? 0) > 0;
}

/** Borra una nota vigente (opcionalmente de un tipo). false si no existe o ya caduco. */
export async function deleteLiveNote(
  db: D1Database,
  id: string,
  nowMs: number,
  kind?: NoteKind,
): Promise<boolean> {
  const where = kind ? `id = ? AND ${LIVE} AND kind = ?` : `id = ? AND ${LIVE}`;
  const binds: unknown[] = kind ? [id, iso(nowMs), kind] : [id, iso(nowMs)];
  const r = await db
    .prepare(`DELETE FROM notes WHERE ${where}`)
    .bind(...binds)
    .run();
  return (r.meta.changes ?? 0) > 0;
}
