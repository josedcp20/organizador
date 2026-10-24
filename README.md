# Organizador

PWA personal + Cloudflare Worker para gestión de eventos, notas y recordatorios.

## Estructura

Monorepo npm workspaces con:

- **shared**: Tipos e utilidades compartidas
- **web**: Frontend PWA con Svelte 5
- **worker**: Backend Cloudflare Worker con Hono

## Configuración

### Requisitos

- Node.js ^20.19.0 o >= 22.12.0
- npm >= 9

### Instalación

```bash
npm ci
```

## Scripts

- `npm run lint` — ESLint en todos los workspaces
- `npm run typecheck` — TypeScript type check en todos los workspaces
- `npm test` — Tests con Vitest en todos los workspaces. Ejecutalos siempre asi (no con `npx vitest` en la raiz): `worker/` usa vitest 4 con el plugin de Cloudflare y cada workspace tiene su propia configuracion.
- `npm run format` / `npm run format:check` — Prettier (escribe / comprueba)

## Despliegue

Push a `main` despliega la web (GitHub Pages) y el Worker (Cloudflare) via GitHub Actions; `ci.yml` valida cada push/PR. Pasos manuales (API token de Cloudflare, secrets `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, variable `VITE_API_BASE`, Pages con Source: GitHub Actions) y despliegue manual (`npx wrangler deploy` en `worker/`) en [docs/setup-cloudflare.md](docs/setup-cloudflare.md).

## Problemas conocidos (Windows)

Si queda un proceso `workerd.exe` colgado (p. ej. tras interrumpir los tests del worker o `wrangler dev`), `npm install`/`npm ci` falla con `EBUSY` al intentar reemplazar sus binarios. Solucion: `taskkill /F /IM workerd.exe` y reintentar.

## Stack

- **Frontend**: Svelte 5 + TypeScript + Vite
- **Backend**: Cloudflare Worker + Hono + D1 (SQLite)
- **Persistencia**: Cloudflare D1
- **Herramientas**: npm workspaces, ESLint, Prettier, Vitest, TypeScript

Los eventos recurrentes no se editan desde la app (solo ver).

## Zona horaria

Referencia: `Europe/Madrid`

## Configuración de la web (login por token)

La PWA necesita `VITE_API_BASE` (URL https del Worker, sin barra final). Copia `web/.env.example` a `web/.env` y rellénalo; en CI es una variable del repo. Si falta o no es https (salvo `http://localhost`/`127.0.0.1`), la app falla en cerrado: no hace ninguna petición. Sin token solo se muestra el login; el token vive en `localStorage` (`organizador_token`). Se admite `#/login?token=...`: se lee y se elimina de la URL al instante.
