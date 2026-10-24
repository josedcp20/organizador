import type { MeResponse } from '@organizador/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { getVersion } from '../version';

export const me = new Hono<AppEnv>();

// Protegido por el middleware de auth montado en /api/*. Nunca devuelve el token ni su hash.
// TODO(fases 2+): ampliar con estado de Google, sync, push y digest (seccion 4 del plan).
me.get('/api/me', (c) => {
  const body: MeResponse = {
    ok: true,
    version: getVersion(c.env),
    tz: c.env.TZ,
    auth: c.get('authKind'),
  };
  const exp = c.get('sessionExpiresAt');
  if (body.auth === 'session' && exp) body.sessionExpiresAt = exp;
  return c.json(body);
});
