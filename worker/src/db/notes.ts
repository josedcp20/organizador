import type { NoteInfo, NoteKind, QuickNoteInfo } from '@organizador/shared';

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
}

const COLS = 'id, body, title, kind, pinned, expires_at, created_at, updated_at';
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
  };
}

export function toQuickInfo(n: NoteInfo): QuickNoteInfo {
  return { id: n.id, body: n.body, expiresAt: n.expiresAt, createdAt: n.createdAt };
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
}

export async function insertNote(db: D1Database, n: NewNote, nowMs: number): Promise<NoteInfo> {
  const id = crypto.randomUUID();
  const ts = iso(nowMs);
  await db
    .prepare(
      `INSERT INTO notes (id, body, title, kind, pinned, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, n.body, n.title, n.kind, n.pinned ? 1 : 0, n.expiresAt, ts, ts)
    .run();
  return {
    id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    pinned: n.pinned,
    expiresAt: n.expiresAt,
    createdAt: ts,
    updatedAt: ts,
  };
}

export interface NoteChanges {
  body?: string;
  title?: string | null;
  pinned?: boolean;
  /** undefined = no tocar; null = sin caducidad. */
  expiresAt?: string | null;
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
  sets.push('updated_at = ?');
  binds.push(iso(nowMs), id, iso(nowMs));
  const r = await db
    .prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND ${LIVE}`)
    .bind(...binds)
    .run();
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
