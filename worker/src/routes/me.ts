import { Hono } from 'hono';
import type { Env } from '../env';
import { getVersion } from '../version';

export const me = new Hono<{ Bindings: Env }>();

// Protegido por el middleware de auth montado en /api/*. Nunca devuelve el token ni su hash.
// TODO(fases 2+): ampliar con estado de Google, sync, push y digest (seccion 4 del plan).
me.get('/api/me', (c) => c.json({ ok: true, version: getVersion(c.env), tz: c.env.TZ }));
