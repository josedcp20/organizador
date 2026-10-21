import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe('GET /api/health', () => {
  it('responde ok y version sin auth', async () => {
    const res = await worker.fetch(new Request('https://example.com/api/health'), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    // Sin APP_VERSION inyectada (solo en deploy) cae a 'dev'.
    expect(body.version).toBe('dev');
    expect(env.TZ).toBe('Europe/Madrid');
  });

  it('404 JSON para rutas desconocidas', async () => {
    const res = await worker.fetch(new Request('https://example.com/nope'), env, ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body).toEqual({ error: { code: expect.any(String), message: expect.any(String) } });
    expect(body.error.code).toBe('not_found');
  });

  it('scheduled placeholder no falla', async () => {
    await expect(worker.scheduled({} as ScheduledController, env, ctx)).resolves.toBeUndefined();
  });
});
