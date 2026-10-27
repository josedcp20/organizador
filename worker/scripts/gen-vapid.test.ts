import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error modulo .mjs sin tipos
import { generateVapidJwk, run, upsertDevVar } from './gen-vapid.mjs';

const script = path.join(import.meta.dirname, 'gen-vapid.mjs');

function fakeStream(isTTY: boolean) {
  return { isTTY, write: vi.fn((_chunk: string) => true) };
}

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function checkJwk(jwk: Record<string, string>) {
  const k = jwk as unknown as JsonWebKey;
  expect(Object.keys(jwk).sort()).toEqual(['crv', 'd', 'kty', 'x', 'y']);
  expect(jwk.kty).toBe('EC');
  expect(jwk.crv).toBe('P-256');
  for (const k of ['x', 'y', 'd']) expect(Buffer.from(jwk[k]!, 'base64url').length).toBe(32);
  const key = await crypto.subtle.importKey(
    'jwk',
    k,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  expect(key.type).toBe('private');
}

describe('gen:vapid', () => {
  it('genera un JWK privado P-256 valido y distinto cada vez', async () => {
    const a = await generateVapidJwk();
    const b = await generateVapidJwk();
    await checkJwk(a);
    expect(a.d).not.toBe(b.d);
  });

  it('con stdout en terminal no escribe nada en stdout y sale con 1', async () => {
    const stdout = fakeStream(true);
    const stderr = fakeStream(true);
    const spy = vi.spyOn(process.stdout, 'write');
    expect(await run({ argv: [], stdout, stderr })).toBe(1);
    expect(stdout.write).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(String(stderr.write.mock.calls[0]?.[0])).toContain(
      'wrangler secret put VAPID_PRIVATE_KEY',
    );
  });

  it('con stdout redirigido escribe solo el JWK (una linea JSON)', async () => {
    const stdout = fakeStream(false);
    expect(await run({ argv: [], stdout, stderr: fakeStream(false) })).toBe(0);
    const out = String(stdout.write.mock.calls[0]?.[0]);
    expect(out.endsWith('\n')).toBe(true);
    await checkJwk(JSON.parse(out));
  });

  it('--dev-vars: guarda en .dev.vars (sustituye la linea) sin imprimir la clave', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-vapid-'));
    tmp.push(dir);
    const file = path.join(dir, '.dev.vars');
    fs.writeFileSync(file, 'ENV=dev\r\nVAPID_PRIVATE_KEY=viejo\r\nAPP_URL=x\r\n');
    const stdout = fakeStream(true);
    const stderr = fakeStream(true);
    expect(await run({ argv: ['--dev-vars'], stdout, stderr, devVarsPath: file })).toBe(0);
    expect(stdout.write).not.toHaveBeenCalled();
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('ENV=dev');
    expect(lines[2]).toBe('APP_URL=x');
    const m = /^VAPID_PRIVATE_KEY='(.+)'$/.exec(lines[1]!);
    await checkJwk(JSON.parse(m![1]!));
    expect(String(stderr.write.mock.calls[0]?.[0])).not.toContain(JSON.parse(m![1]!).d);
  });

  it('upsertDevVar anade la linea si no existe', () => {
    expect(upsertDevVar('', 'V')).toBe("VAPID_PRIVATE_KEY='V'\n");
    expect(upsertDevVar('A=1\n', 'V')).toBe("A=1\nVAPID_PRIVATE_KEY='V'\n");
  });

  it('CLI real con stdout en pipe imprime un JWK', async () => {
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    await checkJwk(JSON.parse(out));
  });
});
