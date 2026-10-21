import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

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
// La cache de API con token llega en T6.2. Push/notificationclick llegan en T4.2.
