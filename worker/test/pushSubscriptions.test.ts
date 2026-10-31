import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { toBase64Url } from '../src/crypto/encoding';
import {
  classifyPushResponse,
  listActive,
  markResult,
  purgeExpired,
  upsertSubscription,
  type ParsedSubscription,
  type StoredSubscription,
} from '../src/db/pushSubscriptions';

const NOW = Date.UTC(2026, 9, 26, 10);
const iso = (ms: number) => new Date(ms).toISOString();
const mk = (i: number, expiresAt: string | null = null): ParsedSubscription => ({
  endpoint: `https://web.push.apple.com/e${i}`,
  p256dh: toBase64Url(new Uint8Array(65)),
  auth: toBase64Url(new Uint8Array(16)),
  expiresAt,
  label: 'iPhone/Mac (Apple)',
});
const all = async () =>
  (
    await env.DB.prepare(
      'SELECT * FROM push_subscriptions ORDER BY endpoint',
    ).all<StoredSubscription>()
  ).results;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM push_subscriptions').run();
});

describe('pushSubscriptions (D1)', () => {
  it('upsert idempotente y expulsion de la mas antigua a la 6a', async () => {
    await upsertSubscription(env.DB, mk(0), iso(NOW));
    await upsertSubscription(env.DB, mk(0), iso(NOW + 1));
    expect(await all()).toHaveLength(1);
    for (let i = 1; i <= 5; i++) await upsertSubscription(env.DB, mk(i), iso(NOW + i * 1000));
    const eps = (await all()).map((r) => r.endpoint);
    expect(eps).toHaveLength(5);
    expect(eps).not.toContain(mk(0).endpoint);
    expect(eps).toContain(mk(5).endpoint);
  });

  it('listActive excluye caducadas y purgeExpired las borra', async () => {
    await upsertSubscription(env.DB, mk(0, iso(NOW - 1)), iso(NOW - 10));
    await upsertSubscription(env.DB, mk(1, iso(NOW)), iso(NOW - 10));
    await upsertSubscription(env.DB, mk(2, iso(NOW + 1)), iso(NOW - 10));
    await upsertSubscription(env.DB, mk(3), iso(NOW - 10));
    expect((await listActive(env.DB, NOW)).map((r) => r.endpoint).sort()).toEqual([
      mk(2).endpoint,
      mk(3).endpoint,
    ]);
    expect(await purgeExpired(env.DB, NOW)).toBe(2);
    expect(await all()).toHaveLength(2);
    expect(await purgeExpired(env.DB, NOW)).toBe(0);
  });

  it.each([
    [201, null, 0],
    [404, 'deleted', 0],
    [410, 'deleted', 0],
    [429, 'retry_429', 1],
    [403, 'rejected_403', 1],
    [500, 'retry_500', 1],
  ] as const)('markResult segun tabla 2.2: %i', async (status, expected, fails) => {
    const s = mk(0);
    await upsertSubscription(env.DB, s, iso(NOW - 10));
    await env.DB.prepare("UPDATE push_subscriptions SET fail_count = 2, last_error = 'x'").run();
    await markResult(env.DB, s.endpoint, classifyPushResponse(status), iso(NOW));
    const rows = await all();
    if (expected === 'deleted') return expect(rows).toHaveLength(0);
    expect(rows).toHaveLength(1);
    if (status === 201) {
      expect(rows[0]).toMatchObject({ last_success_at: iso(NOW), fail_count: 0, last_error: null });
    } else {
      expect(rows[0]).toMatchObject({ fail_count: 2 + fails, last_error: expected });
      expect(rows[0]!.last_success_at).toBeNull();
    }
  });
});
