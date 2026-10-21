import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setClock } from '../src/clock';
import {
  MAX_FAILURES,
  WINDOW_MS,
  clientId,
  ipKey,
  ipv6Prefix64,
  purgeAuthFailures,
  recordFailure,
  resetFailures,
  sha256Hex,
} from '../src/middleware/auth';
import { TEST_TOKEN } from './constants';
import { ORIGIN, call, clearFailures, failureRowCount } from './helpers';

beforeEach(clearFailures);
afterEach(() => setClock());

const fail = (ip: string, headers?: Record<string, string>) =>
  call('/api/me', { ip, auth: 'Bearer nope', headers });
const good = (ip: string, headers?: Record<string, string>) => call('/api/me', { ip, headers });

async function failN(ip: string, n: number, headers?: Record<string, string>): Promise<void> {
  for (let i = 0; i < n; i++) expect((await fail(ip, headers)).status).toBe(401);
}

async function errCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

describe('atomicidad del contador', () => {
  it('una rafaga concurrente de fallos cuenta todos y bloquea (aunque el token sea valido)', async () => {
    const ip = '7.7.7.7';
    const total = 2 * MAX_FAILURES;
    const results = await Promise.all(Array.from({ length: total }, () => fail(ip)));
    const statuses = results.map((r) => r.status);
    // Cada fallo que llega al UPSERT recibe un contador distinto (1..n): el 10o fija el bloqueo
    // (401) y los siguientes (11..) dan 429. Los que ven el bloqueo ya en el SELECT dan 429 sin
    // contar. En cualquier interleaving: exactamente 10 x 401 y 10 x 429. Con un contador no
    // atomico (leer-modificar-escribir) varias peticiones leerian el mismo count y habria >10 401.
    expect(statuses.filter((s) => s === 401)).toHaveLength(MAX_FAILURES);
    expect(statuses.filter((s) => s === 429)).toHaveLength(total - MAX_FAILURES);
    const row = await env.DB.prepare('SELECT count, blocked_until FROM auth_failures').first<{
      count: number;
      blocked_until: string | null;
    }>();
    expect(row?.count).toBeGreaterThanOrEqual(MAX_FAILURES);
    expect(row?.count).toBeLessThanOrEqual(total);
    expect(row?.blocked_until).not.toBeNull();
    expect((await good(ip)).status).toBe(429);
  });

  it('el bloqueo no se prolonga con fallos concurrentes que lo superan', async () => {
    const t0 = Date.UTC(2026, 9, 21, 10, 0, 0);
    setClock(() => t0);
    await Promise.all(Array.from({ length: 15 }, () => fail('7.7.7.8')));
    const a = await env.DB.prepare('SELECT blocked_until FROM auth_failures').first<{
      blocked_until: string;
    }>();
    expect(Date.parse(a?.blocked_until ?? '')).toBe(t0 + 15 * 60 * 1000);
  });
});

describe('IPv6 por prefijo /64', () => {
  it('ipv6Prefix64 normaliza formas equivalentes', () => {
    expect(ipv6Prefix64('2001:db8:1:2::1')).toBe('2001:0db8:0001:0002');
    expect(ipv6Prefix64('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:0db8:0001:0002');
    expect(ipv6Prefix64('2001:db8::')).toBe('2001:0db8:0000:0000');
    expect(ipv6Prefix64('::1')).toBe('0000:0000:0000:0000');
    expect(ipv6Prefix64('::ffff:1.2.3.4')).toBe('0000:0000:0000:0000');
    // IPv4 mapeada en IPv6 -> mismo bucket que la IPv4 (no el /64 comun ::/64).
    expect(clientId('::ffff:1.2.3.4')).toBe('v4:1.2.3.4');
    expect(clientId('::FFFF:1.2.3.4')).toBe('v4:1.2.3.4');
    expect(clientId('::ffff:102:304')).toBe('v4:1.2.3.4');
    expect(clientId('::1')).toBe('v6:0000:0000:0000:0000');
    expect(ipv6Prefix64('fe80::1%eth0')).toBe('fe80:0000:0000:0000');
    expect(ipv6Prefix64('1.2.3.4')).toBeNull();
    expect(ipv6Prefix64('1:2:3')).toBeNull();
    expect(ipv6Prefix64('1::2::3')).toBeNull();
    expect(clientId('1.2.3.4')).toBe('v4:1.2.3.4');
  });

  it('dos IPv6 del mismo /64 comparten bucket y no crean filas nuevas', async () => {
    await failN('2001:db8:1:2::1', 5);
    await failN('2001:db8:1:2:aaaa:bbbb:cccc:dddd', 3);
    await failN('2001:0db8:0001:0002:0:0:0:9', 2);
    expect(await failureRowCount()).toBe(1);
    expect((await good('2001:db8:1:2::77')).status).toBe(429);
  });

  it('IPv6 de /64 distintos tienen buckets independientes', async () => {
    await failN('2001:db8:1:2::1', MAX_FAILURES);
    expect((await good('2001:db8:1:3::1')).status).toBe(200);
    expect((await fail('2001:db8:1:3::1')).status).toBe(401);
    expect(await failureRowCount()).toBe(2);
  });

  it('IPv4 sin cambios: cada IP su bucket', async () => {
    await failN('8.8.8.8', MAX_FAILURES);
    expect((await good('8.8.8.9')).status).toBe(200);
    expect((await good('8.8.8.8')).status).toBe(429);
  });
});

describe('clave HMAC', () => {
  it('la clave guardada es HMAC con secreto, no sha256 de la IP', async () => {
    await fail('4.4.4.4');
    const r = await env.DB.prepare('SELECT ip FROM auth_failures').first<{ ip: string }>();
    expect(r?.ip).toBe(await ipKey('4.4.4.4', env.APP_TOKEN_SHA256 ?? ''));
    expect(r?.ip).toHaveLength(32);
    expect(r?.ip).not.toBe((await sha256Hex('ip:4.4.4.4')).slice(0, 32));
    expect(r?.ip).not.toBe((await sha256Hex('v4:4.4.4.4')).slice(0, 32));
  });

  it('otro secreto produce otra clave', async () => {
    expect(await ipKey('4.4.4.4', 'b'.repeat(64))).not.toBe(await ipKey('4.4.4.4', 'a'.repeat(64)));
  });
});

describe('configuracion invalida (falla en cerrado, sin contar)', () => {
  const cases: Array<[string, string | undefined]> = [
    ['ausente', undefined],
    ['vacio', ''],
    ['corto', 'abc123'],
    ['no hex', 'z'.repeat(64)],
    ['demasiado largo', 'a'.repeat(65)],
  ];
  it.each(cases)(
    'APP_TOKEN_SHA256 %s: ni el token correcto pasa (500 misconfigured)',
    async (_n, v) => {
      const res = await call('/api/me', { ip: '10.9.0.1', env: { APP_TOKEN_SHA256: v } });
      expect(res.status).toBe(500);
      expect(await errCode(res)).toBe('misconfigured');
      expect(await failureRowCount()).toBe(0);
    },
  );

  it('fuera de dev, sin CF-Connecting-IP: 500 misconfigured sin contar', async () => {
    const res = await call('/api/me');
    expect(res.status).toBe(500);
    expect(await errCode(res)).toBe('misconfigured');
    expect(await failureRowCount()).toBe(0);
  });

  it('en dev, sin CF-Connecting-IP se usa un bucket por defecto', async () => {
    const dev = { ENV: 'dev' };
    expect((await call('/api/me', { env: dev })).status).toBe(200);
    const bad = await call('/api/me', { env: dev, auth: 'Bearer x' });
    expect(bad.status).toBe(401);
    expect(await failureRowCount()).toBe(1);
  });
});

describe('fallo de D1', () => {
  it('DB que lanza -> 500 internal_error sin filtrar el mensaje', async () => {
    const boom = () => {
      throw new Error('secret-internal-detail');
    };
    const DB = { prepare: boom } as unknown as D1Database;
    const res = await call('/api/me', { ip: '10.9.1.1', env: { DB } });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret-internal-detail');
    expect(text).not.toContain('"version"');
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe('internal_error');
  });

  it('DB cuyo statement rechaza -> 500 internal_error (next no se ejecuta)', async () => {
    const stmt = {
      bind: () => stmt,
      first: () => Promise.reject(new Error('secret-internal-detail')),
      run: () => Promise.reject(new Error('secret-internal-detail')),
    };
    const DB = { prepare: () => stmt } as unknown as D1Database;
    const res = await call('/api/me', { ip: '10.9.1.2', env: { DB } });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret-internal-detail');
    expect(text).not.toContain('"version"');
  });

  it('DB que falla al registrar un fallo -> 500, no 401', async () => {
    const stmt = {
      bind: () => stmt,
      first: () => Promise.reject(new Error('x')),
    };
    const DB = { prepare: () => stmt } as unknown as D1Database;
    const res = await call('/api/me', { ip: '10.9.1.3', auth: 'Bearer nope', env: { DB } });
    expect(res.status).toBe(500);
  });
});

describe('cabeceras de IP no fiables', () => {
  it('X-Forwarded-For / X-Real-IP / True-Client-IP variados no evaden el bloqueo', async () => {
    const ip = '11.0.0.1';
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await fail(ip, {
        'X-Forwarded-For': `9.9.9.${i}`,
        'X-Real-IP': `8.8.8.${i}`,
        'True-Client-IP': `7.7.7.${i}`,
      });
      expect(res.status).toBe(401);
    }
    const res = await good(ip, {
      'X-Forwarded-For': '1.2.3.4',
      'X-Real-IP': '5.6.7.8',
      'True-Client-IP': '9.10.11.12',
    });
    expect(res.status).toBe(429);
    expect(await failureRowCount()).toBe(1);
  });

  it('mismo X-Forwarded-For con distinto CF-Connecting-IP: buckets independientes', async () => {
    const xff = { 'X-Forwarded-For': '6.6.6.6' };
    await failN('11.0.0.2', MAX_FAILURES, xff);
    expect((await good('11.0.0.2', xff)).status).toBe(429);
    expect((await good('11.0.0.3', xff)).status).toBe(200);
    expect((await fail('11.0.0.3', xff)).status).toBe(401);
  });
});

describe('ENV=dev', () => {
  it('permite el origen http://localhost:5173', async () => {
    const res = await call('/api/health', {
      origin: 'http://localhost:5173',
      auth: null,
      env: { ENV: 'dev' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    const pre = await call('/api/me', {
      method: 'OPTIONS',
      origin: 'http://localhost:5173',
      auth: null,
      env: { ENV: 'dev' },
    });
    expect(pre.status).toBe(204);
    // El origen de produccion sigue permitido en dev.
    const prod = await call('/api/health', { origin: ORIGIN, auth: null, env: { ENV: 'dev' } });
    expect(prod.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });
});

describe('metodos distintos de GET sin token', () => {
  it('POST y DELETE a /api/* sin token cuentan como fallo', async () => {
    const ip = '12.0.0.1';
    for (let i = 0; i < 5; i++) {
      expect((await call('/api/me', { method: 'POST', ip, auth: null })).status).toBe(401);
      expect((await call('/api/me', { method: 'DELETE', ip, auth: null })).status).toBe(401);
    }
    expect(await failureRowCount()).toBe(1);
    expect((await good(ip)).status).toBe(429);
  });

  it('el token correcto no da 401/429 en POST', async () => {
    const res = await call('/api/me', {
      method: 'POST',
      ip: '12.0.0.2',
      auth: `Bearer ${TEST_TOKEN}`,
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(429);
  });
});

describe('purgeAuthFailures', () => {
  it('borra solo filas caducadas', async () => {
    const t = Date.UTC(2026, 9, 21, 12, 0, 0);
    const iso = (ms: number) => new Date(ms).toISOString();
    const ins = (ip: string, ws: number, bu: number | null) =>
      env.DB.prepare(
        'INSERT INTO auth_failures (ip, window_start, count, blocked_until) VALUES (?1, ?2, 3, ?3)',
      )
        .bind(ip, iso(ws), bu === null ? null : iso(bu))
        .run();
    await ins('old-window', t - WINDOW_MS - 1000, null);
    await ins('live-window', t - 1000, null);
    await ins('old-block', t - 2 * WINDOW_MS, t - 1000);
    await ins('live-block', t - 1000, t + 60_000);
    expect(await purgeAuthFailures(env.DB, t)).toBe(2);
    const { results } = await env.DB.prepare('SELECT ip FROM auth_failures ORDER BY ip').all<{
      ip: string;
    }>();
    expect(results.map((r) => r.ip)).toEqual(['live-block', 'live-window']);
  });
});

describe('recordFailure / resetFailures (SQL unitario)', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const t = Date.UTC(2026, 9, 21, 12, 0, 0);
  const ins = (ip: string, ws: number, count: number, bu: number | null) =>
    env.DB.prepare(
      'INSERT INTO auth_failures (ip, window_start, count, blocked_until) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(ip, iso(ws), count, bu === null ? null : iso(bu))
      .run();
  const rowOf = (ip: string) =>
    env.DB.prepare('SELECT count, blocked_until FROM auth_failures WHERE ip = ?1')
      .bind(ip)
      .first<{ count: number; blocked_until: string | null }>();

  it('con bloqueo vigente y count=10, un fallo en t+5min no cambia blocked_until y count=11', async () => {
    const until = t + 12 * 60 * 1000; // != t+5min+BLOCK_MS: detecta una prolongacion
    await ins('k2', t - 1000, MAX_FAILURES, until);
    const res = await recordFailure(env.DB, 'k2', t + 5 * 60 * 1000);
    expect(res).toEqual({ count: MAX_FAILURES + 1, blocked_until: iso(until) });
  });

  it('el fallo que alcanza el umbral fija el bloqueo; uno nuevo inicia ventana', async () => {
    await ins('k3', t - 1000, MAX_FAILURES - 1, null);
    const res = await recordFailure(env.DB, 'k3', t);
    expect(res?.count).toBe(MAX_FAILURES);
    expect(res?.blocked_until).not.toBeNull();
    expect(await recordFailure(env.DB, 'nueva', t)).toEqual({ count: 1, blocked_until: null });
  });

  it('resetFailures no borra un bloqueo vigente, pero si filas sin bloqueo o caducadas', async () => {
    await ins('vigente', t - 1000, 12, t + 60_000);
    await ins('sin-bloqueo', t - 1000, 3, null);
    await ins('caducado', t - 2 * WINDOW_MS, 12, t - 1000);
    await resetFailures(env.DB, 'vigente', t);
    expect(await rowOf('vigente')).not.toBeNull();
    await resetFailures(env.DB, 'sin-bloqueo', t);
    expect(await rowOf('sin-bloqueo')).toBeNull();
    await resetFailures(env.DB, 'caducado', t);
    expect(await rowOf('caducado')).toBeNull();
  });
});
