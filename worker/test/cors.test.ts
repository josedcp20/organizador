import { beforeEach, describe, expect, it } from 'vitest';
import { ORIGIN, call, clearFailures } from './helpers';

beforeEach(clearFailures);

describe('CORS', () => {
  it('preflight de origen permitido', async () => {
    const res = await call('/api/me', {
      method: 'OPTIONS',
      auth: null,
      origin: ORIGIN,
      ip: '9.0.0.1',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe(
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('preflight de origen no permitido: 403 sin cabeceras CORS', async () => {
    const res = await call('/api/me', {
      method: 'OPTIONS',
      auth: null,
      origin: 'https://evil.example',
      ip: '9.0.0.2',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Methods')).toBeNull();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBeDefined();
  });

  it('preflight sin Origin: 403', async () => {
    const res = await call('/api/me', { method: 'OPTIONS', auth: null, ip: '9.0.0.3' });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('origen que solo es prefijo/variante no se permite', async () => {
    for (const o of [`${ORIGIN}.evil.com`, `${ORIGIN}/`, 'http://josedcp20.github.io', 'null']) {
      const res = await call('/api/health', { origin: o, auth: null });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('localhost:5173 no se permite fuera de ENV=dev', async () => {
    const res = await call('/api/health', { origin: 'http://localhost:5173', auth: null });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('peticion real con origen permitido lleva ACAO exacto (nunca *)', async () => {
    const res = await call('/api/me', { origin: ORIGIN, ip: '9.0.0.4' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('los errores 401, 404 y 429 tambien llevan CORS para el origen permitido', async () => {
    const r401 = await call('/api/me', { origin: ORIGIN, auth: null, ip: '9.0.0.5' });
    expect(r401.status).toBe(401);
    expect(r401.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);

    const r404 = await call('/nope', { origin: ORIGIN, auth: null });
    expect(r404.status).toBe(404);
    expect(r404.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);

    for (let i = 0; i < 10; i++) await call('/api/me', { auth: 'Bearer x', ip: '9.0.0.6' });
    const r429 = await call('/api/me', { origin: ORIGIN, ip: '9.0.0.6' });
    expect(r429.status).toBe(429);
    expect(r429.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(r429.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After');
  });

  it('origen no permitido: respuesta sin cabeceras CORS', async () => {
    const res = await call('/api/me', { origin: 'https://evil.example', ip: '9.0.0.7' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('sin Origin: sin cabeceras CORS', async () => {
    const res = await call('/api/me', { ip: '9.0.0.8' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
