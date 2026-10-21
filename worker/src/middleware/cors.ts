import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { errorBody } from '../errors';

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Authorization, Content-Type';
const MAX_AGE = '86400';
const DEV_ORIGIN = 'http://localhost:5173';

function isAllowedOrigin(origin: string, env: Env): boolean {
  if (origin === env.ALLOWED_ORIGIN) return true;
  return env.ENV === 'dev' && origin === DEV_ORIGIN;
}

/**
 * CORS limitado al origen de la PWA (nunca `*`). Origen no permitido: sin cabeceras CORS
 * y preflight 403. Los preflight se resuelven aqui, antes de auth y rate limit.
 */
export const cors: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const origin = c.req.header('Origin');
  const allowed = origin !== undefined && isAllowedOrigin(origin, c.env);

  if (c.req.method === 'OPTIONS') {
    c.header('Vary', 'Origin');
    if (!allowed) {
      return c.json(errorBody('forbidden_origin', 'Origin not allowed'), 403);
    }
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Methods', ALLOW_METHODS);
    c.header('Access-Control-Allow-Headers', ALLOW_HEADERS);
    c.header('Access-Control-Max-Age', MAX_AGE);
    return c.body(null, 204);
  }

  await next();

  c.res.headers.append('Vary', 'Origin');
  if (allowed) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Expose-Headers', 'Retry-After');
  }
  return undefined;
};
