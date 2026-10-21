import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setClock } from '../src/clock';
import { BLOCK_MS, MAX_FAILURES, WINDOW_MS } from '../src/middleware/auth';
import { call, clearFailures, failureRowCount } from './helpers';

let t = 0;
const MIN = 60 * 1000;

beforeEach(async () => {
  t = Date.UTC(2026, 9, 21, 10, 0, 0);
  setClock(() => t);
  await clearFailures();
});
afterEach(() => setClock());

const fail = (ip: string) => call('/api/me', { ip, auth: 'Bearer nope' });
const good = (ip: string) => call('/api/me', { ip });

async function failN(ip: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) expect((await fail(ip)).status).toBe(401);
}

describe('rate limit por IP', () => {
  it('umbral y bloqueo derivan de las constantes exportadas', async () => {
    await failN('1.1.0.1', MAX_FAILURES);
    const res = await fail('1.1.0.1');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBe(BLOCK_MS / 1000);
    t += WINDOW_MS - 1;
    expect((await good('1.1.0.1')).status).toBe(429);
    t += BLOCK_MS;
    expect((await good('1.1.0.1')).status).toBe(200);
  });

  it('9 y 10 fallos dan 401; el 11o da 429 con Retry-After', async () => {
    await failN('1.1.1.1', 10);
    const res = await fail('1.1.1.1');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
    expect(Number(res.headers.get('Retry-After'))).toBe(15 * 60);
  });

  it('con 9 fallos un acierto sigue funcionando (umbral exacto)', async () => {
    await failN('1.1.1.2', 9);
    expect((await good('1.1.1.2')).status).toBe(200);
  });

  it('token correcto tras 10 fallos tambien da 429 durante el bloqueo', async () => {
    await failN('1.1.1.3', 10);
    t += 5 * MIN;
    const res = await good('1.1.1.3');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBe(10 * 60);
    t += 9 * MIN + 59 * 1000;
    expect((await good('1.1.1.3')).status).toBe(429);
  });

  it('el bloqueo no se prolonga con intentos durante el mismo', async () => {
    await failN('1.1.1.4', 10);
    t += 10 * MIN;
    expect((await fail('1.1.1.4')).status).toBe(429);
    t += 5 * MIN;
    expect((await good('1.1.1.4')).status).toBe(200);
  });

  it('el bloqueo expira a los 15 min', async () => {
    await failN('1.1.1.5', 10);
    t += 15 * MIN;
    expect((await good('1.1.1.5')).status).toBe(200);
  });

  it('tras expirar el bloqueo, un fallo empieza ventana nueva (no re-bloquea)', async () => {
    await failN('1.1.1.6', 10);
    t += 15 * MIN;
    expect((await fail('1.1.1.6')).status).toBe(401);
    expect((await good('1.1.1.6')).status).toBe(200);
  });

  it('la ventana de 15 min expira: fallos viejos no se acumulan', async () => {
    await failN('1.1.1.7', 9);
    t += 15 * MIN;
    await failN('1.1.1.7', 9);
    expect((await good('1.1.1.7')).status).toBe(200);
  });

  it('fallos dentro de la ventana (14 min) si se acumulan', async () => {
    await failN('1.1.1.8', 5);
    t += 14 * MIN;
    await failN('1.1.1.8', 5);
    expect((await good('1.1.1.8')).status).toBe(429);
  });

  it('un acierto resetea el contador', async () => {
    await failN('1.1.1.9', 9);
    expect((await good('1.1.1.9')).status).toBe(200);
    expect(await failureRowCount()).toBe(0);
    await failN('1.1.1.9', 9);
    expect((await good('1.1.1.9')).status).toBe(200);
  });

  it('IPs independientes', async () => {
    await failN('2.2.2.1', 10);
    expect((await fail('2.2.2.1')).status).toBe(429);
    expect((await good('2.2.2.2')).status).toBe(200);
    expect((await fail('2.2.2.2')).status).toBe(401);
  });

  it('sin fallos no se escribe en D1 (uso normal)', async () => {
    await good('3.3.3.3');
    await good('3.3.3.3');
    expect(await failureRowCount()).toBe(0);
  });

  it('la IP no se guarda en claro', async () => {
    await fail('4.4.4.4');
    const { env } = await import('cloudflare:workers');
    const r = await env.DB.prepare('SELECT ip FROM auth_failures').first<{ ip: string }>();
    expect(r?.ip).toBeDefined();
    expect(r?.ip).not.toContain('4.4.4.4');
  });

  it('preflight no cuenta ni requiere token', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await call('/api/me', {
        method: 'OPTIONS',
        ip: '5.5.5.5',
        auth: null,
        origin: 'https://josedcp20.github.io',
      });
      expect(res.status).toBe(204);
    }
    expect(await failureRowCount()).toBe(0);
    expect((await good('5.5.5.5')).status).toBe(200);
  });

  it('un 429 no se aplica a /api/health', async () => {
    await failN('6.6.6.6', 10);
    const res = await call('/api/health', { ip: '6.6.6.6', auth: null });
    expect(res.status).toBe(200);
  });
});
