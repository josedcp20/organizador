// Genera la clave VAPID de Web Push: JWK privado P-256 completo (kty, crv, x, y, d) en JSON. Es el
// unico secreto (VAPID_PRIVATE_KEY); el Worker deriva la publica de el.
// Nunca se muestra en pantalla:
//   - stdout redirigido (no TTY): escribe el JWK en stdout para canalizarlo, desde worker/:
//       npm run -s gen:vapid | npx wrangler secret put VAPID_PRIVATE_KEY
//   - `--dev-vars`: lo guarda en worker/.dev.vars (gitignored) sin imprimirlo.
//   - stdout es una terminal: error y salida 1, sin escribir nada.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './gen-token.mjs';

const DEV_VARS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');

export async function generateVapidJwk() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { kty, crv, x, y, d };
}

/** Sustituye (o anade) la linea VAPID_PRIVATE_KEY de un .dev.vars. */
export function upsertDevVar(text, value) {
  const line = `VAPID_PRIVATE_KEY='${value}'`;
  const lines = text ? text.split(/\r?\n/) : [];
  const i = lines.findIndex((l) => /^\s*VAPID_PRIVATE_KEY\s*=/.test(l));
  if (i >= 0) lines[i] = line;
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(line);
  }
  return lines.join('\n') + '\n';
}

export async function run({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  devVarsPath = DEV_VARS,
} = {}) {
  const devVars = argv.includes('--dev-vars');
  if (!devVars && stdout.isTTY) {
    stderr.write(
      'gen:vapid no muestra la clave en pantalla. Canalizala a wrangler:\n' +
        '  npm run -s gen:vapid | npx wrangler secret put VAPID_PRIVATE_KEY\n' +
        'o guardala para local con: npm run gen:vapid -- --dev-vars\n',
    );
    return 1;
  }
  const value = JSON.stringify(await generateVapidJwk());
  if (devVars) {
    const prev = fs.existsSync(devVarsPath) ? fs.readFileSync(devVarsPath, 'utf8') : '';
    fs.writeFileSync(devVarsPath, upsertDevVar(prev, value));
    stderr.write(`VAPID_PRIVATE_KEY guardada en ${devVarsPath} (no se ha mostrado).\n`);
    return 0;
  }
  stdout.write(value + '\n');
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await run();
}
