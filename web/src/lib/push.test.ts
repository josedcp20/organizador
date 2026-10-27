import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, setToken } from './auth';
import {
  disablePush,
  enablePush,
  isPushEnabledHere,
  PUSH_ENABLED_KEY,
  pushSupport,
  syncPushOnOpen,
} from './push';
import {
  fakeSub,
  installPushBrowser,
  OTHER_KEY,
  PUBLIC_KEY,
  uninstallPushBrowser,
} from './pushTestEnv';

type Init = NonNullable<Parameters<typeof fetch>[1]>;
const BASE = 'https://worker.example.workers.dev';
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let order: string[];
const status = {
  configured: true,
  publicKey: PUBLIC_KEY,
  subject: 's',
  subscriptions: [],
  digest: null,
};

beforeEach(() => {
  order = [];
  fetchMock = vi.fn(async (url: string, init?: Init) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
    order.push(key);
    if (key === 'GET /api/push/status') return json(status);
    if (key === 'POST /api/push/subscribe') return json({ id: '0123456789abcdef' });
    if (key === 'DELETE /api/push/subscribe') return new Response(null, { status: 204 });
    throw new Error(`fetch inesperado ${key}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_API_BASE', BASE);
  setToken('tok-1');
  localStorage.removeItem(PUSH_ENABLED_KEY);
});

afterEach(() => {
  uninstallPushBrowser();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearToken();
  localStorage.removeItem(PUSH_ENABLED_KEY);
});

const bodyOf = (method: string) => {
  const c = fetchMock.mock.calls.find((x) => (x[1] as Init | undefined)?.method === method);
  return JSON.parse(String((c![1] as Init).body));
};

describe('pushSupport', () => {
  it('sin PushManager: unsupported; iPhone en Safari sin instalar: ios-not-installed', () => {
    expect(pushSupport()).toBe('unsupported');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(pushSupport()).toBe('ios-not-installed');
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(pushSupport()).toBe('unsupported'); // instalada pero iOS < 16.4
  });

  it('con service worker, PushManager y Notification: ok', () => {
    installPushBrowser();
    expect(pushSupport()).toBe('ok');
  });
});

describe('enablePush', () => {
  it('requestPermission es lo primero (sincrono, antes de cualquier fetch); suscribe y registra', async () => {
    const b = installPushBrowser();
    const p = enablePush(PUBLIC_KEY);
    expect(b.requestPermission).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await p).toBe('granted');
    expect([...b.order, ...order]).toEqual([
      'requestPermission',
      'subscribe',
      'POST /api/push/subscribe',
    ]);
    expect(bodyOf('POST').endpoint).toBe('https://web.push.apple.com/NEW');
    const opts = b.pushManager.subscribe.mock.calls[0]![0] as unknown as {
      userVisibleOnly: boolean;
    };
    expect(opts.userVisibleOnly).toBe(true);
    expect(isPushEnabledHere()).toBe(true);
    const headers = (fetchMock.mock.calls[0]![1] as Init).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-1');
  });

  it('permiso denegado: no suscribe ni llama al servidor', async () => {
    const b = installPushBrowser({ permission: 'denied' });
    expect(await enablePush(PUBLIC_KEY)).toBe('denied');
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isPushEnabledHere()).toBe(false);
  });

  it('suscripcion existente con otra clave: se rehace', async () => {
    const old = fakeSub('https://web.push.apple.com/OLD', OTHER_KEY);
    const b = installPushBrowser({ current: old });
    await enablePush(PUBLIC_KEY);
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(b.pushManager.subscribe).toHaveBeenCalled();
  });
});

describe('syncPushOnOpen', () => {
  it('activado y con suscripcion de la misma clave: re-POST sin re-suscribir', async () => {
    const cur = fakeSub('https://web.push.apple.com/CUR');
    const b = installPushBrowser({ permission: 'granted', current: cur });
    localStorage.setItem(PUSH_ENABLED_KEY, '1');
    await syncPushOnOpen();
    expect(b.pushManager.subscribe).not.toHaveBeenCalled();
    expect(order).toEqual(['GET /api/push/status', 'POST /api/push/subscribe']);
    expect(bodyOf('POST').endpoint).toBe('https://web.push.apple.com/CUR');
  });

  it('activado sin suscripcion local o con clave cambiada: re-suscribe', async () => {
    const b = installPushBrowser({ permission: 'granted' });
    localStorage.setItem(PUSH_ENABLED_KEY, '1');
    await syncPushOnOpen();
    expect(b.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const old = fakeSub('https://web.push.apple.com/OLD', OTHER_KEY);
    const c = installPushBrowser({ permission: 'granted', current: old });
    await syncPushOnOpen();
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(c.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('no activado aqui, sin permiso o sin soporte: no hace nada', async () => {
    await syncPushOnOpen();
    installPushBrowser({ permission: 'granted', current: fakeSub('e') });
    await syncPushOnOpen(); // sin la marca local
    localStorage.setItem(PUSH_ENABLED_KEY, '1');
    installPushBrowser({ permission: 'denied', current: fakeSub('e') });
    await syncPushOnOpen();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errores del servidor: silencioso', async () => {
    installPushBrowser({ permission: 'granted', current: fakeSub('e') });
    localStorage.setItem(PUSH_ENABLED_KEY, '1');
    fetchMock.mockImplementation(async () => json({ error: { code: 'x', message: 'x' } }, 500));
    await expect(syncPushOnOpen()).resolves.toBeUndefined();
  });
});

describe('disablePush', () => {
  it('baja en el servidor con el endpoint y en el navegador; borra la marca', async () => {
    const cur = fakeSub('https://web.push.apple.com/CUR');
    installPushBrowser({ permission: 'granted', current: cur });
    localStorage.setItem(PUSH_ENABLED_KEY, '1');
    await disablePush();
    expect(bodyOf('DELETE')).toEqual({ endpoint: 'https://web.push.apple.com/CUR' });
    expect(cur.unsubscribe).toHaveBeenCalled();
    expect(isPushEnabledHere()).toBe(false);
  });
});
