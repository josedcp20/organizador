/* global NotificationPermission */
import type { PushStatusResponse, PushTestResult } from '@organizador/shared';
import { apiFetch } from './api';
import { b64urlToBuffer, bufferToB64url } from './passkeys';

/** Marca local "push activado en este dispositivo" (el permiso sobrevive a "Desactivar"). */
export const PUSH_ENABLED_KEY = 'organizador_push';

/** Id (del servidor) de la suscripcion de este dispositivo. */
const PUSH_ID_KEY = 'organizador_push_id';

export type PushSupport = 'ok' | 'ios-not-installed' | 'unsupported';

function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  );
}

/** iOS solo tiene PushManager en la PWA instalada en la pantalla de inicio (16.4+). */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
    return 'ok';
  }
  return isIos() && !isStandalone() ? 'ios-not-installed' : 'unsupported';
}

export function isPushEnabledHere(): boolean {
  try {
    return window.localStorage.getItem(PUSH_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function localPushId(): string | null {
  try {
    return window.localStorage.getItem(PUSH_ID_KEY);
  } catch {
    return null;
  }
}

function setEnabledHere(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(PUSH_ENABLED_KEY, '1');
    else {
      window.localStorage.removeItem(PUSH_ENABLED_KEY);
      window.localStorage.removeItem(PUSH_ID_KEY);
    }
  } catch {
    // ignorar
  }
}

export function fetchPushStatus(): Promise<PushStatusResponse> {
  return apiFetch<PushStatusResponse>('/api/push/status');
}

export function sendTestPush(): Promise<PushTestResult> {
  return apiFetch<PushTestResult>('/api/push/test', { method: 'POST', body: {} });
}

export function sendDigestNow(): Promise<PushTestResult> {
  return apiFetch<PushTestResult>('/api/push/digest-now', { method: 'POST', body: {} });
}

export function removePushDevice(id: string): Promise<void> {
  return apiFetch<void>(`/api/push/subscribe?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  // getRegistration (no `ready`): sin SW (dev) resuelve undefined en vez de quedarse esperando.
  return navigator.serviceWorker.getRegistration();
}

function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const k = sub.options?.applicationServerKey;
  return !!k && bufferToB64url(k) === publicKey;
}

async function subscribeAndRegister(
  reg: ServiceWorkerRegistration,
  publicKey: string,
): Promise<void> {
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    // Clave VAPID rotada: la suscripcion vieja ya no sirve.
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64urlToBuffer(publicKey),
  });
  const r = await apiFetch<{ id?: string }>('/api/push/subscribe', {
    method: 'POST',
    body: sub.toJSON(),
  });
  try {
    if (r?.id) window.localStorage.setItem(PUSH_ID_KEY, r.id);
  } catch {
    // ignorar
  }
}

/**
 * Activar desde un clic. `Notification.requestPermission()` es la PRIMERA instruccion, sin
 * ningun await antes: Safari pierde el gesto del usuario y no muestra el dialogo.
 */
export function enablePush(publicKey: string): Promise<NotificationPermission> {
  const permission = Notification.requestPermission();
  return (async () => {
    const p = await permission;
    if (p !== 'granted') return p;
    const reg = await registration();
    if (!reg) throw new Error('No hay service worker registrado. Recarga la app.');
    await subscribeAndRegister(reg, publicKey);
    setEnabledHere(true);
    return p;
  })();
}

/** Desactivar en este dispositivo: baja en el servidor (best effort) y en el navegador. */
export async function disablePush(): Promise<void> {
  setEnabledHere(false);
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await apiFetch('/api/push/subscribe', {
    method: 'DELETE',
    body: { endpoint: sub.endpoint },
  }).catch(() => undefined);
  await sub.unsubscribe().catch(() => false);
}

/**
 * Al abrir la app con sesion: si push esta activado aqui y hay permiso, vuelve a registrar la
 * suscripcion (idempotente) o la rehace si falta o cambio la clave del servidor. Nunca lanza.
 */
export async function syncPushOnOpen(): Promise<void> {
  try {
    if (pushSupport() !== 'ok' || !isPushEnabledHere()) return;
    if (Notification.permission !== 'granted') return;
    const reg = await registration();
    if (!reg) return;
    const status = await fetchPushStatus();
    if (!status.configured || !status.publicKey) return;
    // Sin gesto la re-suscripcion puede fallar (Safari): Ajustes ofrece reactivar.
    await subscribeAndRegister(reg, status.publicKey);
  } catch {
    // silencioso: no debe molestar al abrir la app
  }
}

/** ¿Este dispositivo tiene suscripcion en el navegador? */
export async function hasLocalSubscription(): Promise<boolean> {
  try {
    return !!(await (await registration())?.pushManager.getSubscription());
  } catch {
    return false;
  }
}
