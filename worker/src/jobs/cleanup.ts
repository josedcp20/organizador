import { purgeExpired as purgeExpiredPush } from '../db/pushSubscriptions';
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
  pushSubs: number;
  reminderLog: number;
  digestLog: number;
}> {
  const notes = await cleanupExpiredNotes(db, nowMs);
  await purgeOrphanDone(db, nowMs);
  const authFailures = await purgeAuthFailures(db, nowMs);
  const { sessions, challenges } = await purgeExpired(db, nowMs);
  const pushSubs = await purgeExpiredPush(db, nowMs);
  const iso = (days: number) => new Date(nowMs - days * 86_400_000).toISOString();
  const reminderLog =
    (await db.prepare('DELETE FROM reminder_log WHERE updated_at < ?1').bind(iso(90)).run()).meta
      .changes ?? 0;
  // digest_log.date es YYYY-MM-DD (Madrid); comparar con la fecha UTC de corte basta a 60 dias.
  const digestLog =
    (await db.prepare('DELETE FROM digest_log WHERE date < ?1').bind(iso(60).slice(0, 10)).run())
      .meta.changes ?? 0;
  return { notes, authFailures, sessions, challenges, pushSubs, reminderLog, digestLog };
}
