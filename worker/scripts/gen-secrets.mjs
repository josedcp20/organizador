// Genera las claves del Worker para OAuth Google: TOKEN_ENC_KEY (AES-256-GCM del refresh token
// en D1) y OAUTH_STATE_KEY (HMAC de tickets y `state`). 32 bytes aleatorios cada una, base64url.
// Solo se imprimen en consola: nunca se escriben a disco.

import { isMain } from './gen-token.mjs';

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateSecrets() {
  return {
    TOKEN_ENC_KEY: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    OAUTH_STATE_KEY: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

if (isMain(import.meta.url)) {
  const secrets = generateSecrets();
  console.log('Claves nuevas (no se guardan en ningun sitio; copialas ahora):');
  for (const [name, value] of Object.entries(secrets)) console.log(`${name}: ${value}`);
  console.log('');
  console.log('Cargalas en Cloudflare (pega el valor cuando wrangler lo pida), desde worker/:');
  for (const name of Object.keys(secrets)) console.log(`  npx wrangler secret put ${name}`);
  console.log('');
  console.log('Avisos:');
  console.log(
    '- Cambiar TOKEN_ENC_KEY invalida el refresh token guardado: hay que reconectar Google.',
  );
  console.log('- Cambiar OAUTH_STATE_KEY solo invalida tickets/state en curso (vida < 10 min).');
  console.log('- Para local, usa valores distintos en worker/.dev.vars (nunca los de produccion).');
}
