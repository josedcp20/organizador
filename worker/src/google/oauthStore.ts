/**
 * Registro de un solo uso para tickets de /start y `state` de OAuth, en la tabla `job_state`
 * (clave `oauth:<tipo>:<nonce>`, valor JSON con `exp` en ms y datos opcionales).
 *
 * El consumo es un unico `DELETE ... RETURNING`: dos canjes concurrentes del mismo nonce no
 * pueden tener exito ambos. Solo se llega aqui con un token cuya firma HMAC ya se verifico, asi
 * que un cliente sin credenciales no puede provocar escrituras en D1.
 */
export type OneTimeKind = 'ticket' | 'state';

const PREFIX = 'oauth:';

function keyOf(kind: OneTimeKind, nonce: string): string {
  return `${PREFIX}${kind}:${nonce}`;
}

export async function storeOneTime(
  db: D1Database,
  kind: OneTimeKind,
  nonce: string,
  expMs: number,
  nowMs: number,
  data: Record<string, string> = {},
): Promise<void> {
  await db
    .prepare('INSERT INTO job_state (key, value, updated_at) VALUES (?1, ?2, ?3)')
    .bind(
      keyOf(kind, nonce),
      JSON.stringify({ ...data, exp: expMs }),
      new Date(nowMs).toISOString(),
    )
    .run();
}

/**
 * Consume (borra) el registro y devuelve sus datos si existia y no habia caducado; null en otro
 * caso. Un registro caducado tambien se borra.
 */
export async function consumeOneTime(
  db: D1Database,
  kind: OneTimeKind,
  nonce: string,
  nowMs: number,
): Promise<Record<string, string> | null> {
  const row = await db
    .prepare('DELETE FROM job_state WHERE key = ?1 RETURNING value')
    .bind(keyOf(kind, nonce))
    .first<{ value: string }>();
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { exp, ...rest } = parsed as Record<string, unknown>;
  if (typeof exp !== 'number' || !(exp > nowMs)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Borra tickets/state caducados (se llama al emitir un ticket). Devuelve filas borradas. */
export async function purgeExpiredOneTime(db: D1Database, nowMs: number): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM job_state
       WHERE substr(key, 1, ${PREFIX.length}) = ?1
         AND COALESCE(CAST(json_extract(value, '$.exp') AS INTEGER), 0) <= ?2`,
    )
    .bind(PREFIX, nowMs)
    .run();
  return res.meta.changes;
}
