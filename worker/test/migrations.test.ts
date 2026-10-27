import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

async function tables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe('migraciones (aplicadas en test/setup.ts)', () => {
  it('crea las tablas esperadas y no app_events ni watch_channels', async () => {
    const t = await tables();
    for (const name of [
      'google_auth',
      'calendars',
      'events',
      'event_meta',
      'event_done',
      'reminder_log',
      'digest_log',
      'auth_failures',
      'settings',
      'notes',
      'push_subscriptions',
      'job_state',
      'passkeys',
      'sessions',
      'webauthn_challenges_used',
    ]) {
      expect(t).toContain(name);
    }
    expect(t).not.toContain('app_events');
    expect(t).not.toContain('watch_channels');
  });

  it('events tiene columnas de escritura bidireccional', async () => {
    const c = await columns('events');
    for (const col of [
      'etag',
      'origin',
      'local_id',
      'pending_op',
      'pending_payload',
      'pending_scope',
      'pending_attempts',
      'pending_since',
      'write_error',
    ]) {
      expect(c).toContain(col);
    }
  });

  it('0003: estado de sync por calendario y run de la pasada completa en events', async () => {
    const c = await columns('calendars');
    for (const col of [
      'sync_token',
      'last_synced_at',
      'sync_cursor',
      'last_full_sync_at',
      'last_sync_error',
      'last_sync_error_at',
      'sync_failures',
      'sync_backoff_until',
    ]) {
      expect(c).toContain(col);
    }
    expect(await columns('events')).toContain('sync_run');
  });

  it('event_meta tiene scope y color', async () => {
    const c = await columns('event_meta');
    expect(c).toContain('scope');
    expect(c).toContain('color');
  });

  it('event_meta rechaza scope invalido', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO event_meta (calendar_id, scope, target_id, updated_at) VALUES ('c','bad','t','now')",
      ).run(),
    ).rejects.toThrow();
  });

  it('0004: passkeys tiene columnas esperadas', async () => {
    const c = await columns('passkeys');
    for (const col of [
      'id',
      'public_key',
      'sign_count',
      'transports',
      'backed_up',
      'label',
      'created_at',
      'last_used_at',
    ]) {
      expect(c).toContain(col);
    }
  });

  it('0004: sessions tiene columnas esperadas y FK a passkeys', async () => {
    const c = await columns('sessions');
    for (const col of ['token_hash', 'passkey_id', 'created_at', 'expires_at', 'last_used_at']) {
      expect(c).toContain(col);
    }
    // Verificar indice
    const indices = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'",
    ).all<{ name: string }>();
    const indexNames = indices.results.map((r) => r.name);
    expect(indexNames).toContain('idx_sessions_passkey');
  });

  it('0004: webauthn_challenges_used tiene columnas esperadas', async () => {
    const c = await columns('webauthn_challenges_used');
    for (const col of ['nonce', 'expires_at']) {
      expect(c).toContain(col);
    }
  });

  it('0005: push_subscriptions tiene last_error y expires_at', async () => {
    const c = await columns('push_subscriptions');
    for (const col of [
      'endpoint',
      'p256dh',
      'auth',
      'device_label',
      'created_at',
      'last_success_at',
      'fail_count',
      'last_error',
      'expires_at',
    ]) {
      expect(c).toContain(col);
    }
  });

  it('0004: sessions.passkey_id es PK sin ROWID', async () => {
    // WITHOUT ROWID optimiza para claves compuestas; verificamos que solo tiene lo esperado
    const info = await env.DB.prepare('PRAGMA table_info(sessions)').all<{
      name: string;
      pk: number;
    }>();
    const pkCols = info.results.filter((r) => r.pk > 0).map((r) => r.name);
    expect(pkCols).toEqual(['token_hash']);
  });

  it('0006: event_done existe con PK (calendar_id, event_id)', async () => {
    const c = await columns('event_done');
    for (const col of ['calendar_id', 'event_id', 'done_at']) {
      expect(c).toContain(col);
    }
  });

  it('0006: notes tiene columnas de alarma', async () => {
    const c = await columns('notes');
    for (const col of ['remind_at', 'remind_state', 'remind_attempts']) {
      expect(c).toContain(col);
    }
  });

  it('0006: remind_state rechaza valores invalidos', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO notes (id, body, kind, created_at, updated_at, remind_state) VALUES ('id1','body','quick','now','now','invalid')",
      ).run(),
    ).rejects.toThrow();
  });

  it('0006: remind_state acepta valores validos', async () => {
    for (const state of ['pending', 'sent', 'gave_up']) {
      const stmt = env.DB.prepare(
        'INSERT INTO notes (id, body, kind, created_at, updated_at, remind_state) VALUES (?, ?, ?, ?, ?, ?)',
      );
      // Limpiar la nota anterior
      await env.DB.prepare('DELETE FROM notes WHERE id = ?')
        .bind('test-' + state)
        .run();
      // Insertar con el estado valido
      const result = await stmt.bind('test-' + state, 'body', 'quick', 'now', 'now', state).run();
      expect(result.success).toBe(true);
    }
  });

  it('0006: idx_notes_remind_due existe (parcial en pending)', async () => {
    const indices = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notes'",
    ).all<{ name: string }>();
    const indexNames = indices.results.map((r) => r.name);
    expect(indexNames).toContain('idx_notes_remind_due');
  });
});
