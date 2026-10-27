import { purgeOrphanDone } from '../db/eventDone';
import { purgeExpired } from '../db/sessions';
import { purgeAuthFailures } from '../middleware/auth';

/**
 * Limpieza periodica (T3.3). Borra notas y notas rapidas caducadas (misma tabla `notes`).
 * Idempotente: ejecutarla dos veces seguidas borra 0 filas la segunda. Una nota caduca
 * exactamente en `expires_at` (`<= ahora`), coherente con el filtro de lectura.
 * Devuelve el numero de filas borradas. No toca Google.
 */
export async function cleanupExpiredNotes(db: D1Database, nowMs: number): Promise<number> {
  const r = await db
    .prepare('DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .bind(new Date(nowMs).toISOString())
    .run();
  return r.meta.changes ?? 0;
}

/** Paso `cleanup` del cron: notas caducadas + auth_failures + sesiones y challenges WebAuthn caducados. */
export async function runCleanup(
  db: D1Database,
  nowMs: number,
): Promise<{
  notes: number;
  authFailures: number;
  sessions: number;
  challenges: number;
}> {
  const notes = await cleanupExpiredNotes(db, nowMs);
  await purgeOrphanDone(db, nowMs);
  const authFailures = await purgeAuthFailures(db, nowMs);
  const { sessions, challenges } = await purgeExpired(db, nowMs);
  return { notes, authFailures, sessions, challenges };
}
