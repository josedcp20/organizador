import { Hono } from 'hono';
import { deleteAllSessions, deleteSession, isSessionToken } from '../db/sessions';
import type { AppEnv } from '../env';
import { extractBearer } from '../middleware/auth';

export const session = new Hono<AppEnv>();

// Revoca solo la sesion actual. Con el token estatico no hay nada que revocar: 204 igualmente.
session.post('/api/session/logout', async (c) => {
  const token = extractBearer(c.req.header('Authorization'));
  if (c.get('authKind') === 'session' && isSessionToken(token)) {
    await deleteSession(c.env.DB, token);
  }
  return c.body(null, 204);
});

session.delete('/api/sessions', async (c) => {
  return c.json({ revoked: await deleteAllSessions(c.env.DB) });
});
