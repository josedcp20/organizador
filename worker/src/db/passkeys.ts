import type { PasskeyInfo } from '@organizador/shared';
import { PASSKEY_LIMITS } from '@organizador/shared';

/** Fila completa (incluye clave publica y contador): solo para verificar, nunca para la API. */
export interface PasskeyRow {
  id: string;
  publicKey: string; // COSE base64url
  signCount: number;
  transports: string[] | null;
  backedUp: boolean;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface DbRow {
  id: string;
  public_key: string;
  sign_count: number;
  transports: string | null;
  backed_up: number;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

function toRow(r: DbRow): PasskeyRow {
  let transports: string[] | null = null;
  if (r.transports) {
    try {
      const t: unknown = JSON.parse(r.transports);
      if (Array.isArray(t)) transports = t.filter((x): x is string => typeof x === 'string');
    } catch {
      // transports corruptos: se tratan como ausentes
    }
  }
  return {
    id: r.id,
    publicKey: r.public_key,
    signCount: r.sign_count,
    transports,
    backedUp: r.backed_up === 1,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export const toPasskeyInfo = (p: PasskeyRow): PasskeyInfo => ({
  id: p.id,
  label: p.label,
  createdAt: p.createdAt,
  lastUsedAt: p.lastUsedAt,
  backedUp: p.backedUp,
});

export async function getPasskey(db: D1Database, id: string): Promise<PasskeyRow | null> {
  const r = await db.prepare('SELECT * FROM passkeys WHERE id = ?1').bind(id).first<DbRow>();
  return r ? toRow(r) : null;
}

export async function listPasskeys(db: D1Database): Promise<PasskeyRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM passkeys ORDER BY created_at, id')
    .all<DbRow>();
  return results.map(toRow);
}

export type InsertPasskeyResult = 'ok' | 'duplicate' | 'limit';

/** Inserta de forma atomica respetando duplicado y limite (sin carrera entre COUNT e INSERT). */
export async function insertPasskey(
  db: D1Database,
  p: Omit<PasskeyRow, 'signCount' | 'lastUsedAt'>,
): Promise<InsertPasskeyResult> {
  const r = await db
    .prepare(
      `INSERT INTO passkeys (id, public_key, sign_count, transports, backed_up, label, created_at)
       SELECT ?1, ?2, 0, ?3, ?4, ?5, ?6
       WHERE NOT EXISTS (SELECT 1 FROM passkeys WHERE id = ?1)
         AND (SELECT COUNT(*) FROM passkeys) < ?7`,
    )
    .bind(
      p.id,
      p.publicKey,
      p.transports ? JSON.stringify(p.transports) : null,
      p.backedUp ? 1 : 0,
      p.label,
      p.createdAt,
      PASSKEY_LIMITS.maxPasskeys,
    )
    .run();
  if (r.meta.changes === 1) return 'ok';
  return (await getPasskey(db, p.id)) ? 'duplicate' : 'limit';
}

/** Actualiza contador y ultimo uso tras un login correcto (FID-5). */
export async function updatePasskeyUsage(
  db: D1Database,
  id: string,
  signCount: number,
  nowIso: string,
): Promise<void> {
  await db
    .prepare('UPDATE passkeys SET sign_count = ?2, last_used_at = ?3 WHERE id = ?1')
    .bind(id, signCount, nowIso)
    .run();
}

/** Borra la passkey y sus sesiones en un batch (sin depender del cascade). true si existia. */
export async function deletePasskey(db: D1Database, id: string): Promise<boolean> {
  const [, r] = await db.batch([
    db.prepare('DELETE FROM sessions WHERE passkey_id = ?1').bind(id),
    db.prepare('DELETE FROM passkeys WHERE id = ?1').bind(id),
  ]);
  return (r?.meta.changes ?? 0) > 0;
}
