import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error modulo .mjs sin tipos
import { generateSecrets } from './gen-secrets.mjs';

const script = path.join(import.meta.dirname, 'gen-secrets.mjs');

describe('gen:secrets', () => {
  it('genera dos claves de 32 bytes base64url distintas', () => {
    const s = generateSecrets() as Record<string, string>;
    expect(Object.keys(s).sort()).toEqual(['OAUTH_STATE_KEY', 'TOKEN_ENC_KEY']);
    for (const v of Object.values(s)) {
      expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(v, 'base64url').length).toBe(32);
    }
    expect(s.TOKEN_ENC_KEY).not.toBe(s.OAUTH_STATE_KEY);
  });

  it('el CLI imprime claves nuevas en cada ejecucion e instrucciones de wrangler', () => {
    const run = () => execFileSync(process.execPath, [script], { encoding: 'utf8' });
    const key = (out: string, name: string) => new RegExp(`${name}: (\\S+)`).exec(out)![1];
    const a = run();
    const b = run();
    expect(key(a, 'TOKEN_ENC_KEY')).not.toBe(key(b, 'TOKEN_ENC_KEY'));
    expect(key(a, 'OAUTH_STATE_KEY')).not.toBe(key(b, 'OAUTH_STATE_KEY'));
    expect(a).toContain('wrangler secret put TOKEN_ENC_KEY');
    expect(a).toContain('wrangler secret put OAUTH_STATE_KEY');
  });
});
