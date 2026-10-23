import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env } from './env';
import { errorBody } from './errors';
import { auth } from './middleware/auth';
import { cors } from './middleware/cors';
import { calendars } from './routes/calendars';
import { me } from './routes/me';
import { oauth } from './routes/oauth';
import { getVersion } from './version';

export const app = new Hono<{ Bindings: Env }>();

app.use('*', cors);
// Auth en todo /api/* (excepto /api/health, ver PUBLIC_API_PATHS). /oauth/* (start/callback de Google) queda fuera: se autoriza con ticket/state firmados.
app.use('/api/*', auth);

app.get('/api/health', (c) => c.json({ ok: true, version: getVersion(c.env) }));
app.route('/', me);
app.route('/', oauth);
app.route('/', calendars);

app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const status = err.status;
    const code = status === 400 ? 'validation' : status === 401 ? 'unauthorized' : 'http_error';
    return c.json(errorBody(code, status >= 500 ? 'Internal error' : err.message), status);
  }
  // Solo el nombre del error: nunca mensaje/traza (podrian contener datos sensibles).
  console.error('unhandled_error', err instanceof Error ? err.name : 'unknown');
  return c.json(errorBody('internal_error', 'Internal error'), 500);
});

export default app;
