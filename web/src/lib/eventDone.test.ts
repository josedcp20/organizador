import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearToken, setToken } from './auth';
import { setEventDone, toggleEventDone } from './eventDetail';

const BASE = 'https://worker.example.workers.dev';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ id: 'e1', done: true }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_BASE', BASE);
  setToken('tok');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearToken();
});

describe('setEventDone', () => {
  it('PUT /done con {done} y devuelve el evento', async () => {
    const r = await setEventDone('c@x', 'e1', true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/agenda/c%40x/e1/done`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ done: true });
    expect(r.done).toBe(true);
  });
});

describe('toggleEventDone', () => {
  it('aplica optimista y conserva si va bien', async () => {
    const seen: boolean[] = [];
    expect(await toggleEventDone('c', 'e', true, (d) => seen.push(d))).toBeNull();
    expect(seen).toEqual([true]);
  });

  it('revierte y devuelve mensaje si falla', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'x' }, 500));
    const seen: boolean[] = [];
    const msg = await toggleEventDone('c', 'e', true, (d) => seen.push(d));
    expect(seen).toEqual([true, false]);
    expect(msg).toMatch(/^No se pudo marcar el evento/);
  });
});
