import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error modulo .mjs sin tipos
import { generateToken } from './gen-token.mjs';

const script = path.join(import.meta.dirname, 'gen-token.mjs');

function decodeLength(token: string): number {
  return Buffer.from(token, 'base64url').length;
}

describe('gen:token', () => {
  it('token >= 32 bytes base64url y hash SHA-256 hex correcto', async () => {
    const { token, hash } = (await generateToken()) as { token: string; hash: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLength(token)).toBeGreaterThanOrEqual(32);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('el CLI imprime token y hash distintos en dos ejecuciones', () => {
    const run = () => execFileSync(process.execPath, [script], { encoding: 'utf8' });
    const parse = (out: string) => ({
      token: /TOKEN[^:]*: (\S+)/.exec(out)![1],
      hash: /APP_TOKEN_SHA256[^:]*: (\S+)/.exec(out)![1],
    });
    const a = parse(run());
    const b = parse(run());
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
    expect(decodeLength(a.token)).toBeGreaterThanOrEqual(32);
    expect(a.hash).toBe(createHash('sha256').update(a.token).digest('hex'));
  });

  it('invocado sin extension no sale en silencio con codigo 0', () => {
    let status: number | null = 0;
    try {
      execFileSync(process.execPath, [script.replace(/\.mjs$/, '')], { stdio: 'pipe' });
    } catch (err) {
      status = (err as { status: number | null }).status;
    }
    expect(status).not.toBe(0);
  });
});
