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
  /** JWK privado P-256 completo (JSON). La clave publica se deriva de el (gen:vapid). */
  VAPID_PRIVATE_KEY?: string;
  /** `sub` del JWT VAPID ([vars], U2). Sin valor se usa APP_URL. */
  VAPID_SUBJECT?: string;
}

/** Tipo de Hono con las variables de contexto que fija el middleware de auth. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    /** 'static' = token maestro, 'session' = token s1.* de passkey. Ausente en rutas publicas. */
    authKind: 'static' | 'session';
    sessionExpiresAt?: string;
  };
}
