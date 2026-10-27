import { now } from '../clock';

/** Marca/desmarca un evento como hecho (solo D1). Idempotente: re-marcar conserva el primer done_at. */
export async function setEventDone(
  db: D1Database,
  calendarId: string,
  eventId: string,
  done: boolean,
): Promise<void> {
  const stmt = done
    ? db
        .prepare(
          'INSERT INTO event_done (calendar_id, event_id, done_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING',
        )
        .bind(calendarId, eventId, new Date(now()).toISOString())
    : db
        .prepare('DELETE FROM event_done WHERE calendar_id = ?1 AND event_id = ?2')
        .bind(calendarId, eventId);
  await stmt.run();
}

export const deleteEventDone = (db: D1Database, calendarId: string, eventId: string) =>
  setEventDone(db, calendarId, eventId, false);

/** Filas huerfanas (sin evento en D1) marcadas hace mas de 90 dias. */
export async function purgeOrphanDone(db: D1Database, nowMs: number): Promise<number> {
  const r = await db
    .prepare(
      `DELETE FROM event_done WHERE done_at < ?1
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.calendar_id = event_done.calendar_id AND e.id = event_done.event_id)`,
    )
    .bind(new Date(nowMs - 90 * 86_400_000).toISOString())
    .run();
  return r.meta.changes ?? 0;
}
