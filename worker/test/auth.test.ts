import { beforeEach, describe, expect, it } from 'vitest';
import { extractBearer, sha256Hex, timingSafeEqualStr } from '../src/middleware/auth';
import { TEST_TOKEN, call, clearFailures } from './helpers';

beforeEach(clearFailures);

async function errCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(Object.keys(body)).toEqual(['error']);
  expect(typeof body.error.message).toBe('string');
  return body.error.code;
}

describe('helpers', () => {
  it('timingSafeEqualStr maneja longitudes distintas', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStr('', 'abc')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });

  it('sha256Hex produce hex de 64 caracteres (vector conocido)', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('extractBearer', () => {
    expect(extractBearer('Bearer abc')).toBe('abc');
    expect(extractBearer('bearer abc')).toBe('abc');
    expect(extractBearer('Basic abc')).toBeNull();
    expect(extractBearer('Bearer')).toBeNull();
    expect(extractBearer('Bearer a b')).toBeNull();
    expect(extractBearer('')).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
  });
});

describe('autenticacion Bearer', () => {
  it('200 con token correcto', async () => {
    const res = await call('/api/me', { ip: '10.0.0.1' });
    expect(res.status).toBe(200);
  });

  it('401 sin cabecera Authorization', async () => {
    const res = await call('/api/me', { ip: '10.0.0.2', auth: null });
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe('unauthorized');
  });

  const bad: Array<[string, string]> = [
    ['token incorrecto', 'Bearer wrong-token'],
    ['prefijo del token', `Bearer ${TEST_TOKEN.slice(0, 10)}`],
    ['token con sufijo', `Bearer ${TEST_TOKEN}x`],
    ['token vacio', 'Bearer '],
    ['sin esquema', TEST_TOKEN],
    ['esquema Basic', `Basic ${TEST_TOKEN}`],
    ['esquema mal formado', `Bearer${TEST_TOKEN}`],
    ['token con espacios extra', `Bearer ${TEST_TOKEN} extra`],
    ['token muy largo', `Bearer ${'a'.repeat(5000)}`],
  ];
  it.each(bad)('401 con %s', async (_n, header) => {
    const res = await call('/api/me', { ip: '10.0.0.3', auth: header });
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe('unauthorized');
  });

  it('acepta esquema bearer en minusculas', async () => {
    const res = await call('/api/me', { ip: '10.0.0.4', auth: `bearer ${TEST_TOKEN}` });
    expect(res.status).toBe(200);
  });

  it('el hash enviado como token no sirve (el secreto es el hash, no el token)', async () => {
    const hash = await sha256Hex(TEST_TOKEN);
    const res = await call('/api/me', { ip: '10.0.0.5', auth: `Bearer ${hash}` });
    expect(res.status).toBe(401);
  });
});

describe('/api/health y /api/me', () => {
  it('/api/health es publico', async () => {
    const res = await call('/api/health', { ip: '10.0.1.1', auth: null });
    expect(res.status).toBe(200);
  });

  it('/api/health no cuenta ni escribe fallos', async () => {
    for (let i = 0; i < 15; i++) await call('/api/health', { ip: '10.0.1.2', auth: 'Bearer bad' });
    const res = await call('/api/me', { ip: '10.0.1.2' });
    expect(res.status).toBe(200);
  });

  it('/api/me protegido y su cuerpo no contiene token ni hash', async () => {
    expect((await call('/api/me', { ip: '10.0.1.3', auth: null })).status).toBe(401);
    const res = await call('/api/me', { ip: '10.0.1.3' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).not.toContain(await sha256Hex(TEST_TOKEN));
    const body = JSON.parse(text) as { ok: boolean; version: string; tz: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.tz).toBe('Europe/Madrid');
  });

  it('rutas /api desconocidas sin token dan 401 (no revelan existencia)', async () => {
    const res = await call('/api/nope', { ip: '10.0.1.4', auth: null });
    expect(res.status).toBe(401);
  });

  it('rutas /api desconocidas con token dan 404 JSON', async () => {
    const res = await call('/api/nope', { ip: '10.0.1.5' });
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('not_found');
  });
});
