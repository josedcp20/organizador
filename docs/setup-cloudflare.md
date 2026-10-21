# Despliegue: Cloudflare + GitHub Pages

Pasos manuales (una sola vez) para que un push a `main` despliegue web y Worker.

## 1. Cloudflare (M1-M3)

1. Cuenta gratuita en dash.cloudflare.com (plan Workers Free) y elegir el subdominio `*.workers.dev` (Workers & Pages > Overview). El Worker queda en `https://organizador-api.<subdominio>.workers.dev`.
2. En local: `npx wrangler login`, `npx wrangler d1 create organizador` (copiar `database_id` a `worker/wrangler.toml`; no es secreto) y cargar secretos con `npx wrangler secret put APP_TOKEN_SHA256` (solo el hash; generar con `npm run gen:token -w worker`).
3. Crear un **API token** (My Profile > API Tokens > Create Token) con la plantilla **Edit Cloudflare Workers** y anadir el permiso **Account > D1 > Edit**. Anotar tambien el **Account ID** (barra lateral de Workers & Pages).

## 2. GitHub (M3b)

Repo `josedcp20/organizador` (publico; verifica que no hay secretos antes de publicar).

- Settings > Secrets and variables > Actions > **Secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Misma pantalla > **Variables**: `VITE_API_BASE` = URL https del Worker, sin barra final (p. ej. `https://organizador-api.jose-dcp20.workers.dev`). El deploy de la web falla si esta vacia o no es https.
- Settings > Pages > Build and deployment > **Source: GitHub Actions**.

## 3. Workflows

| Workflow            | Cuando                                                                                | Que hace                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ci.yml`            | push y pull_request                                                                   | lint, typecheck, tests, format:check y build de la web. Sin secretos.                              |
| `deploy-web.yml`    | push a `main`, manual                                                                 | build con `VITE_API_BASE` y publicacion en GitHub Pages (`/organizador/`).                         |
| `deploy-worker.yml` | push a `main` con cambios en `worker/**`, `shared/**`, lockfile o el workflow; manual | tests del worker, `wrangler d1 migrations apply organizador --remote` y despues `wrangler deploy`. |

La version que devuelve `/api/health` (y `/api/me`, visible en Ajustes de la web) es el hash corto del commit, inyectado con `--var APP_VERSION:<sha>`. En local y tests es `dev`.

Los workflows no usan `pull_request_target`; los PR de forks no reciben secretos y solo ejecutan `ci.yml` con permisos de solo lectura.

## 4. Despliegue manual

```bash
cd worker
npx wrangler d1 migrations apply organizador --remote
npx wrangler deploy
```

Para la web, `npm run build -w web` con `VITE_API_BASE` definida; la publicacion se hace por el workflow `deploy-web.yml` (workflow_dispatch desde la pestana Actions).
