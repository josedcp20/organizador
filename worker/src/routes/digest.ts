import { formatDateInTz } from '@organizador/shared';
import { Hono } from 'hono';
import { now } from '../clock';
import type { Env } from '../env';
import { errorBody } from '../errors';
import { buildDigest, buildDigestText } from '../jobs/digest';
import { loadDigestInputs } from '../jobs/notify';
import { DEFAULT_TZ } from '../sync/window';

/** Plan B (T4.9): el resumen de hoy + manana para el Atajo de iOS (Bearer via el middleware de /api/*). */
export const digest = new Hono<{ Bindings: Env }>();

digest.get('/api/digest', async (c) => {
  const format = c.req.query('format') ?? 'text';
  if (format !== 'text' && format !== 'json') {
    return c.json(errorBody('validation', "format must be 'text' or 'json'"), 400);
  }
  const tz = c.env.TZ || DEFAULT_TZ;
  const nowMs = now();
  const today = formatDateInTz(new Date(nowMs), tz);
  const d = await loadDigestInputs(c.env.DB, today, nowMs, tz);
  const [t, m, n] = [d.todayEvents, d.tomorrowEvents, d.quickNotesCount];
  c.header('Cache-Control', 'no-store');
  const text = buildDigestText(t, m, n, tz);
  if (format === 'text') return c.text(text);
  return c.json({ ...buildDigest(t, m, n, tz, today), text });
});

/** Cierra el banner de Hoy (resumen de hoy fallido/abandonado). Idempotente: 204. */
digest.post('/api/digest/ack', async (c) => {
  const today = formatDateInTz(new Date(now()), c.env.TZ || DEFAULT_TZ);
  await c.env.DB.prepare('UPDATE digest_log SET acknowledged = 1 WHERE date = ?1')
    .bind(today)
    .run();
  return c.body(null, 204);
});
