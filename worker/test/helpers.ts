import { env } from 'cloudflare:workers';
import type { Env } from '../src/env';
import worker from '../src/index';

import { TEST_TOKEN } from './constants';

export { TEST_TOKEN };
export const ORIGIN = 'https://josedcp20.github.io';

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

export interface CallOptions {
  method?: string;
  ip?: string;
  auth?: string | null; // valor completo de Authorization; null = sin cabecera
  origin?: string;
  headers?: Record<string, string>;
  env?: Partial<Env>; // sobrescribe bindings/vars (p. ej. ENV='dev' o un DB falso)
}

export function call(path: string, opts: CallOptions = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.ip) headers.set('CF-Connecting-IP', opts.ip);
  if (opts.auth !== null) headers.set('Authorization', opts.auth ?? `Bearer ${TEST_TOKEN}`);
  if (opts.origin) headers.set('Origin', opts.origin);
  return Promise.resolve(
    worker.fetch(
      new Request(`https://example.com${path}`, { method: opts.method, headers }),
      { ...env, ...opts.env },
      ctx,
    ),
  );
}

export async function clearFailures(): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_failures').run();
}

export async function failureRowCount(): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_failures').first<{ n: number }>();
  return r?.n ?? 0;
}
