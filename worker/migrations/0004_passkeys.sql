-- 0004_passkeys: autenticacion con passkeys (WebAuthn, Face ID en iOS)

-- Credenciales WebAuthn registradas (una por dispositivo)
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,                  -- credential id (base64url)
  public_key TEXT NOT NULL,             -- clave publica COSE (base64url)
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                      -- JSON ['internal','hybrid'] o NULL
  backed_up INTEGER NOT NULL DEFAULT 0, -- flag BS (sincronizada en iCloud)
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- Sesiones autenticadas (token opaco s1.*, caducable, revocar sin rotar token maestro)
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,          -- SHA-256 hex del token s1.*; nunca el token
  passkey_id TEXT NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT
) WITHOUT ROWID;
CREATE INDEX idx_sessions_passkey ON sessions(passkey_id);

-- Challenges de un solo uso consumidos (nonce de token firmado)
CREATE TABLE webauthn_challenges_used (
  nonce TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
) WITHOUT ROWID;
