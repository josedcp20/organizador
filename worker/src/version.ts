/**
 * Version del despliegue: hash corto del commit, inyectado en deploy con
 * `wrangler deploy --var APP_VERSION:<sha>` (ver .github/workflows/deploy-worker.yml).
 * En local y tests no esta definida y cae a 'dev'.
 */
export function getVersion(env: { APP_VERSION?: string }): string {
  const v = env.APP_VERSION?.trim();
  return v ? v : 'dev';
}
