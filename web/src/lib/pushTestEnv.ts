/* global NotificationPermission */
// Solo tests: navegador simulado con service worker, PushManager y Notification.
import { vi } from 'vitest';

export const PUBLIC_KEY =
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
export const OTHER_KEY =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';

export function keyBuffer(b64url: string): ArrayBuffer {
  const s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
}

export interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => unknown;
  unsubscribe: ReturnType<typeof vi.fn>;
}

export function fakeSub(endpoint: string, key = PUBLIC_KEY): FakeSub {
  return {
    endpoint,
    options: { applicationServerKey: keyBuffer(key) },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

export function installPushBrowser(
  opts: { permission?: NotificationPermission; current?: FakeSub | null } = {},
) {
  const order: string[] = [];
  const state = { current: opts.current ?? null, permission: opts.permission ?? 'default' };
  const pushManager = {
    getSubscription: vi.fn(async () => state.current),
    subscribe: vi.fn(async (o: { applicationServerKey: ArrayBuffer }) => {
      order.push('subscribe');
      const s = fakeSub('https://web.push.apple.com/NEW');
      s.options.applicationServerKey = o.applicationServerKey;
      state.current = s;
      return s;
    }),
  };
  const reg = { pushManager };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn(async () => reg) },
  });
  vi.stubGlobal('PushManager', function PushManager() {});
  const requestPermission = vi.fn(() => {
    order.push('requestPermission');
    const p: NotificationPermission = state.permission === 'default' ? 'granted' : state.permission;
    state.permission = p;
    return Promise.resolve(p);
  });
  vi.stubGlobal('Notification', {
    get permission() {
      return state.permission;
    },
    requestPermission,
  });
  return { order, state, pushManager, requestPermission };
}

export function uninstallPushBrowser(): void {
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
}
