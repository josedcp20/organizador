import { Hono } from 'hono';
import { now } from '../clock';
import type { Env } from '../env';
import { errorBody } from '../errors';
import { runSync } from '../sync/engine';

/**
 * `POST /api/sync`: fuerza una pasada de sync (protegido por el Bearer de /api/*). Limitado a
 * 1/minuto (job_state 'sync_manual_at', UPSERT atomico). Solo lee de Google.
 */
export const sync = new Hono<{ Bindings: Env }>();

export const MANUAL_SYNC_INTERVAL_MS = 60_000;

sync.post('/api/sync', async (c) => {
  c.header('Cache-Control', 'no-store');
  const db = c.env.DB;
  const nowMs = now();
  const throttle = await db
    .prepare(
      `INSERT INTO job_state (key, value, updated_at) VALUES ('sync_manual_at', '1', ?1)
       ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at
       WHERE job_state.updated_at <= ?2`,
    )
    .bind(new Date(nowMs).toISOString(), new Date(nowMs - MANUAL_SYNC_INTERVAL_MS).toISOString())
    .run();
  if (throttle.meta.changes !== 1) {
    c.header('Retry-After', '60');
    return c.json(errorBody('rate_limited', 'Sync was requested less than a minute ago'), 429);
  }

  const r = await runSync(c.env, { nowMs });
  switch (r.status) {
    case 'ok':
      return c.json(r);
    case 'busy':
      return c.json(errorBody('sync_busy', 'A sync is already running'), 409);
    case 'not_connected':
      return c.json(errorBody('google_not_connected', 'Google is not connected'), 409);
    case 'misconfigured':
      return c.json(errorBody('misconfigured', 'Google OAuth is not configured'), 500);
    case 'auth_rejected': // access token rechazado y olvidado: el siguiente intento lo renueva
    case 'unavailable':
      return c.json(errorBody('google_unavailable', 'Google is not available'), 502);
  }
});
