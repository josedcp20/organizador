// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = mkdtempSync(join(tmpdir(), 'organizador-pwa-'));

interface Icon {
  src: string;
  sizes: string;
  purpose?: string;
}

beforeAll(async () => {
  await build({ root, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
}, 180_000);

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe('PWA build', () => {
  it('manifest con start_url/scope /organizador/ y standalone', () => {
    const m = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    expect(m.start_url).toBe('/organizador/');
    expect(m.scope).toBe('/organizador/');
    expect(m.display).toBe('standalone');
    expect(m.lang).toBe('es');
    expect(m.orientation).toBeUndefined();
  });

  it('iconos 192, 512 y maskable existen en disco', () => {
    const m = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    const icons: Icon[] = m.icons;
    const has = (sizes: string, purpose: string) =>
      icons.find((i) => i.sizes === sizes && (i.purpose ?? 'any') === purpose);
    for (const icon of [has('192x192', 'any'), has('512x512', 'any'), has('512x512', 'maskable')]) {
      expect(icon).toBeDefined();
      expect(existsSync(join(outDir, icon!.src))).toBe(true);
    }
  });

  it('index.html: un unico manifest y apple-touch-icon', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    expect(html.match(/<link rel="manifest"/g)).toHaveLength(1);
    const href = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1];
    expect(href).toBeDefined();
    expect(existsSync(join(outDir, href!.replace('/organizador/', '')))).toBe(true);
  });

  it('sw: sin imports ES, skipWaiting y sin cache de /api', () => {
    const sw = readFileSync(join(outDir, 'sw.js'), 'utf8');
    expect(sw).not.toMatch(/^\s*import[\s{]/m);
    expect(sw).toContain('skipWaiting');
    expect(sw).toContain('clients.claim');
    expect(sw).not.toContain('/api');
  });

  it('sw: push siempre muestra notificacion y notificationclick', () => {
    const sw = readFileSync(join(outDir, 'sw.js'), 'utf8');
    expect(sw).toContain('showNotification');
    expect(sw).toContain('notificationclick');
    expect(sw).toContain('pushsubscriptionchange');
    expect(sw).not.toContain('/api');
  });
});
