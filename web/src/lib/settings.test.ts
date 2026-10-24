import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchSettings, patchSettings } from './settings';
import { setToken, clearToken } from './auth';

let fetchMock: ReturnType<typeof vi.fn>;
const ok = (b: unknown) =>
  new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_BASE', 'https://w.example.workers.dev');
  setToken('t');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearToken();
});

describe('settings', () => {
  it('GET /api/settings', async () => {
    const s = { app_events_color: null, default_write_calendar: 'a' };
    fetchMock.mockResolvedValue(ok(s));
    expect(await fetchSettings()).toEqual(s);
    expect(fetchMock.mock.calls[0][0]).toBe('https://w.example.workers.dev/api/settings');
  });

  it('PATCH /api/settings con el parcial', async () => {
    fetchMock.mockResolvedValue(ok({ app_events_color: '#112233', default_write_calendar: null }));
    await patchSettings({ app_events_color: '#112233' });
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ app_events_color: '#112233' });
  });
});
