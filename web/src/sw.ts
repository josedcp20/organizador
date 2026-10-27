import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';
import { clickTarget, parsePush } from './swPush';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

// Actualizacion inmediata: con `injectManifest`, `registerType: 'autoUpdate'` solo
// funciona si el SW se activa solo. Sin esto, la PWA instalada en iOS seguiria con
// la version antigua hasta cerrar todas las pestanas/ventanas (dias). Los assets van
// con hash y se precachean, asi que la pagina antigua sigue siendo consistente hasta
// que `registerSW` recarga (autoUpdate). Se prefiere esto a un aviso de recarga por
// ser mas simple y no requerir UI.
void self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

precacheAndRoute(self.__WB_MANIFEST);

// PRIVACIDAD: este SW NO registra ninguna ruta de runtime (registerRoute) y por tanto
// nunca cachea `/api/*` (datos privados): esas peticiones van siempre a red.
// La cache de API con token llega en T6.2.

// --- Web Push (Fase 4). El SW NO llama al servidor (no tiene token): el alta de la suscripcion
// la hace la app al abrirse (lib/push.ts syncPushOnOpen).

// Siempre se muestra una notificacion: iOS revoca la suscripcion ante un push silencioso.
self.addEventListener('push', (event) => {
  let text: string | null = null;
  try {
    text = event.data?.text() ?? null;
  } catch {
    text = null;
  }
  const { title, options } = parsePush(text);
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = clickTarget(
    self.registration.scope,
    (event.notification.data as { url?: unknown } | null)?.url,
  );
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins[0];
      if (win) {
        try {
          await win.focus();
          await win.navigate(target);
          return;
        } catch {
          // navigate puede fallar (ventana no controlada / iOS): se abre otra
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

// Best effort (Safari no lo dispara): re-suscribe con las mismas opciones. El servidor recibe
// el endpoint nuevo la proxima vez que se abra la app.
self.addEventListener('pushsubscriptionchange', (event: Event) => {
  const e = event as ExtendableEvent & { oldSubscription?: PushSubscription | null };
  const options = e.oldSubscription?.options;
  if (!options?.applicationServerKey) return;
  e.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey })
      .then(() => undefined)
      .catch(() => undefined),
  );
});
