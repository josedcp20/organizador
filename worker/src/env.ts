export interface Env {
  // Bindings
  DB: D1Database;

  // Variables ([vars] en wrangler.toml)
  TZ: string;
  ALLOWED_ORIGIN: string;
  APP_URL: string;
  /** URI de redireccion OAuth registrada en Google (exacta). En local: http://localhost:8787/oauth/google/callback. */
  GOOGLE_REDIRECT_URI?: string;
  ENV?: string;
  /** Hash corto del commit; solo se inyecta en deploy (--var). Ausente en local/tests -> 'dev'. */
  APP_VERSION?: string;

  // Secretos (wrangler secret put / .dev.vars)
  APP_TOKEN_SHA256?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENC_KEY?: string;
  OAUTH_STATE_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_SUBJECT?: string;
}
