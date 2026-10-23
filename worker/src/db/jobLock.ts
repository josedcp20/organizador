/**
 * Lock con lease sobre `job_state` (una fila por lock). Evita que dos ejecuciones (dos crons
 * solapados, o cron + POST /api/sync) trabajen a la vez. El lease caduca solo si el dueno muere;
 * el dueno lo renueva (heartbeat) en cada escritura y las escrituras se "vallan" con `lockFence`
 * para que un dueno cuyo lease ya expiro y fue tomado por otro no escriba nada.
 */

export interface JobLock {
  key: string;
  owner: string;
}

/** Intenta tomar el lock. null si lo tiene otro con lease vigente. */
export async function acquireLock(
  db: D1Database,
  key: string,
  ttlMs: number,
  nowMs: number,
): Promise<JobLock | null> {
  const owner = crypto.randomUUID();
  const nowIso = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - ttlMs).toISOString();
  const res = await db
    .prepare(
      `INSERT INTO job_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE job_state.updated_at < ?4`,
    )
    .bind(key, owner, nowIso, staleBefore)
    .run();
  return res.meta.changes === 1 ? { key, owner } : null;
}

/** Libera el lock solo si sigue siendo nuestro. */
export async function releaseLock(db: D1Database, lock: JobLock): Promise<void> {
  await db
    .prepare('DELETE FROM job_state WHERE key = ?1 AND value = ?2')
    .bind(lock.key, lock.owner)
    .run();
}

/** Renueva el lease (para meter en un batch). */
export function heartbeat(db: D1Database, lock: JobLock, nowMs: number): D1PreparedStatement {
  return db
    .prepare('UPDATE job_state SET updated_at = ?3 WHERE key = ?1 AND value = ?2')
    .bind(lock.key, lock.owner, new Date(nowMs).toISOString());
}

/**
 * Condicion SQL "el lock sigue siendo mio". `n` = indice del parametro (?n) donde se bindea
 * `lock.owner`; la clave va literal (solo claves internas fijas, nunca entrada de usuario).
 */
export function lockFence(key: string, n: number): string {
  if (!/^[a-z_]+$/.test(key)) throw new Error('bad_lock_key');
  return `EXISTS (SELECT 1 FROM job_state WHERE key = '${key}' AND value = ?${n})`;
}
