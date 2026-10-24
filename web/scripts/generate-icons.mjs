// Genera los PNG de public/icons a partir de source.svg (reproducible).
// Uso: npm run icons -w web
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dir = new URL('../public/icons/', import.meta.url);
const svg = await readFile(new URL('source.svg', dir));

// El SVG ya ocupa el ~80% central con fondo solido a sangre: valido como maskable (zona segura).
const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
];
for (const [name, size] of targets) {
  await sharp(svg, { density: 384 })
    .resize(size, size)
    .flatten({ background: '#2F5BEA' })
    .png()
    .toFile(fileURLToPath(new URL(name, dir)));
  console.log('generado', name);
}
