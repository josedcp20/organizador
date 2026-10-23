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
      'reminder_log',
      'digest_log',
      'auth_failures',
      'settings',
      'notes',
      'push_subscriptions',
      'job_state',
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
});
