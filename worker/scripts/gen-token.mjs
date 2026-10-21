// Genera un token de usuario (32 bytes aleatorios, base64url) y su SHA-256 en hex.
// El hash va en el secreto APP_TOKEN_SHA256; el token en claro solo se muestra aqui (no se escribe a disco).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function normalizePath(p) {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync(r);
  } catch {
    // Si no existe (p. ej. invocado sin extension), usa la ruta resuelta tal cual.
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const self = normalizePath(fileURLToPath(metaUrl));
  if (self === normalizePath(argv1)) return true;
  // Invocado sin extension (`node scripts/gen-token`): Node resuelve a .js/.mjs.
  return self === normalizePath(argv1 + path.extname(self));
}

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function generateToken(byteLength = 32) {
  if (byteLength < 32) throw new Error('El token debe tener al menos 32 bytes');
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return { token, hash: toHex(new Uint8Array(digest)) };
}

if (isMain(import.meta.url)) {
  try {
    const { token, hash } = await generateToken();
    console.log(`TOKEN (guardalo ahora, no se vuelve a mostrar): ${token}`);
    console.log(`APP_TOKEN_SHA256 (para wrangler secret put): ${hash}`);
  } catch (err) {
    console.error(
      `gen-token: no se pudo generar el token: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}
