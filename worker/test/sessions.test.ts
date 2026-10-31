import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setClock } from '../src/clock';
import {
  TOUCH_INTERVAL_MS,
  createSession,
  deleteAllSessions,
  findSession,
} from '../src/db/sessions';
import { runCleanup } from '../src/jobs/cleanup';
import { MAX_FAILURES, sha256Hex } from '../src/middleware/auth';
import { call, clearFailures, failureRowCount } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const IP = '9.9.9.9';

beforeEach(async () => {
  setClock(() => T0);
  await clearFailures();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM passkeys').run();
  await env.DB.prepare('DELETE FROM webauthn_challenges_used').run();
  await env.DB.prepare(
    "INSERT INTO passkeys (id, public_key, label, created_at) VALUES ('pk1','k','iPhone','x')",
  ).run();
});
afterEach(() => setClock());

const sessionCount = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())?.n ?? 0;
const me = (token: string, ip = IP) => call('/api/me', { ip, auth: `Bearer ${token}` });
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

describe('sesion valida', () => {
  it('/api/me 200 con auth=session y caducidad a 30 dias; solo guarda el hash', async () => {
    const { token, expiresAt } = await createSession(env.DB, 'pk1', T0);
    expect(token).toMatch(/^s1\.[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(new Date(T0 + 30 * DAY).toISOString());
    const res = await me(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.auth).toBe('session');
    expect(body.sessionExpiresAt).toBe(expiresAt);
    const row = await env.DB.prepare('SELECT token_hash FROM sessions').first<{
      token_hash: string;
    }>();
    expect(row?.token_hash).toBe(await sha256Hex(token));
  });

  it('el token estatico sigue dando auth=static sin sessionExpiresAt', async () => {
    const res = await call('/api/me', { ip: IP });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.auth).toBe('static');
    expect('sessionExpiresAt' in body).toBe(false);
  });

  it('uso normal = 0 escrituras; last_used_at se toca como mucho una vez al dia', async () => {
    const { token } = await createSession(env.DB, 'pk1', T0);
    const lastUsed = async () =>
      (await env.DB.prepare('SELECT last_used_at AS l FROM sessions').first<{ l: string | null }>())
        ?.l;
    for (let i = 0; i < 3; i++) expect((await me(token)).status).toBe(200);
    expect(await lastUsed()).toBeNull();
    const t1 = T0 + TOUCH_INTERVAL_MS + 1000;
    setClock(() => t1);
    expect((await me(token)).status).toBe(200);
    expect(await lastUsed()).toBe(new Date(t1).toISOString());
    setClock(() => t1 + 60_000);
    expect((await me(token)).status).toBe(200);
    expect(await lastUsed()).toBe(new Date(t1).toISOString());
  });

  it('un acierto resetea los fallos previos', async () => {
    const { token } = await createSession(env.DB, 'pk1', T0);
    await call('/api/me', { ip: IP, auth: 'Bearer nope' });
    expect(await failureRowCount()).toBe(1);
    expect((await me(token)).status).toBe(200);
    expect(await failureRowCount()).toBe(0);
  });
});

describe('sesion invalida', () => {
  it('caducada -> 401 y cuenta fallo', async () => {
    const { token } = await createSession(env.DB, 'pk1', T0);
    setClock(() => T0 + 30 * DAY);
    const res = await me(token);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('unauthorized');
    expect(await failureRowCount()).toBe(1);
  });

  it('inexistente, y token con hash de otra sesion caducada -> 401', async () => {
    const old = await createSession(env.DB, 'pk1', T0 - 31 * DAY);
    expect((await me(old.token)).status).toBe(401);
    const other = await createSession(env.DB, 'pk1', T0);
    const forged = other.token.slice(0, -1) + (other.token.endsWith('A') ? 'B' : 'A');
    expect((await me(forged)).status).toBe(401);
    expect(await findSession(env.DB, forged, T0)).toBeNull();
  });

  it('revocada -> 401', async () => {
    const { token } = await createSession(env.DB, 'pk1', T0);
    await env.DB.prepare('DELETE FROM sessions').run();
    expect((await me(token)).status).toBe(401);
  });

  it.each([
    's1.',
    's1.abc',
    `s1.${'A'.repeat(44)}`,
    `s1.${'!'.repeat(43)}`,
    `S1.${'A'.repeat(43)}`,
  ])('mal formada %s -> 401', async (tok) => {
    const res = await me(tok);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('unauthorized');
  });

  it('10 fallos con s1 invalido -> 429; despues ni una sesion valida pasa', async () => {
    const { token } = await createSession(env.DB, 'pk1', T0);
    const bad = `s1.${'A'.repeat(43)}`;
    for (let i = 0; i < MAX_FAILURES; i++) expect((await me(bad)).status).toBe(401);
    const blocked = await me(token);
    expect(blocked.status).toBe(429);
    expect(await code(blocked)).toBe('rate_limited');
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });
});

describe('logout y revocacion', () => {
  it('logout borra solo la sesion actual', async () => {
    const a = await createSession(env.DB, 'pk1', T0);
    const b = await createSession(env.DB, 'pk1', T0);
    const res = await call('/api/session/logout', {
      method: 'POST',
      ip: IP,
      auth: `Bearer ${a.token}`,
    });
    expect(res.status).toBe(204);
    expect((await me(a.token)).status).toBe(401);
    expect((await me(b.token, '9.9.9.8')).status).toBe(200);
    expect(await sessionCount()).toBe(1);
  });

  it('logout con token estatico no borra sesiones; sin auth -> 401', async () => {
    await createSession(env.DB, 'pk1', T0);
    const res = await call('/api/session/logout', { method: 'POST', ip: IP });
    expect(res.status).toBe(204);
    expect(await sessionCount()).toBe(1);
    const noAuth = await call('/api/session/logout', { method: 'POST', ip: IP, auth: null });
    expect(noAuth.status).toBe(401);
  });

  it('DELETE /api/sessions borra todas', async () => {
    const a = await createSession(env.DB, 'pk1', T0);
    await createSession(env.DB, 'pk1', T0);
    const res = await call('/api/sessions', { method: 'DELETE', ip: IP });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 2 });
    expect(await sessionCount()).toBe(0);
    expect((await me(a.token)).status).toBe(401);
    expect(await deleteAllSessions(env.DB)).toBe(0);
  });

  it('una sesion tambien puede revocar todas', async () => {
    const a = await createSession(env.DB, 'pk1', T0);
    const res = await call('/api/sessions', {
      method: 'DELETE',
      ip: IP,
      auth: `Bearer ${a.token}`,
    });
    expect(res.status).toBe(200);
  });
});

describe('cleanup', () => {
  it('purga sesiones caducadas y challenges usados vencidos, e idempotente', async () => {
    await createSession(env.DB, 'pk1', T0 - 31 * DAY);
    await createSession(env.DB, 'pk1', T0);
    const iso = (ms: number) => new Date(ms).toISOString();
    await env.DB.prepare(
      'INSERT INTO webauthn_challenges_used (nonce, expires_at) VALUES (?1, ?2), (?3, ?4)',
    )
      .bind('old', iso(T0 - 1000), 'fresh', iso(T0 + 1000))
      .run();
    const r = await runCleanup(env.DB, T0);
    expect(r.sessions).toBe(1);
    expect(r.challenges).toBe(1);
    expect(await sessionCount()).toBe(1);
    const again = await runCleanup(env.DB, T0);
    expect(again.sessions + again.challenges).toBe(0);
  });

  it('purga suscripciones push caducadas, reminder_log > 90 d y digest_log > 60 d', async () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const key = 'AAAA';
    await env.DB.batch([
      env.DB.prepare('DELETE FROM push_subscriptions'),
      env.DB.prepare('DELETE FROM reminder_log'),
      env.DB.prepare('DELETE FROM digest_log'),
      env.DB.prepare(
        'INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, expires_at) VALUES (?1,?2,?2,?3,?4),(?5,?2,?2,?3,NULL)',
      ).bind(
        'https://web.push.apple.com/old',
        key,
        iso(T0),
        iso(T0 - 1),
        'https://web.push.apple.com/ok',
      ),
      env.DB.prepare(
        "INSERT INTO reminder_log (calendar_id, event_id, start_key, status, updated_at) VALUES ('c','old','k','sent',?1),('c','new','k','sent',?2)",
      ).bind(iso(T0 - 91 * DAY), iso(T0 - 89 * DAY)),
      env.DB.prepare("INSERT INTO digest_log (date, status) VALUES (?1,'sent'),(?2,'sent')").bind(
        iso(T0 - 61 * DAY).slice(0, 10),
        iso(T0 - 59 * DAY).slice(0, 10),
      ),
    ]);
    const r = await runCleanup(env.DB, T0);
    expect([r.pushSubs, r.reminderLog, r.digestLog]).toEqual([1, 1, 1]);
    const count = async (t: string) =>
      (await env.DB.prepare('SELECT COUNT(*) n FROM ' + t).first<{ n: number }>())!.n;
    expect([
      await count('push_subscriptions'),
      await count('reminder_log'),
      await count('digest_log'),
    ]).toEqual([1, 1, 1]);
    const again = await runCleanup(env.DB, T0);
    expect([again.pushSubs, again.reminderLog, again.digestLog]).toEqual([0, 0, 0]);
  });
});
