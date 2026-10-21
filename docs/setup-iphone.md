# Instalar Organizador en iPhone

1. Abre Safari (no Chrome) y entra en la URL de la app (`https://<usuario>.github.io/organizador/`).
2. Pulsa Compartir y elige "Anadir a pantalla de inicio".
3. Confirma el nombre "Organizador" y pulsa "Anadir".
4. Abre la app desde el icono de la pantalla de inicio: debe abrirse a pantalla completa (standalone), sin barra de Safari.

## Comprobaciones manuales (no automatizables)

- [ ] El icono en la pantalla de inicio es el calendario/check azul (no una captura de la pagina).
- [ ] La app abre en modo standalone, sin barra de direcciones.
- [ ] Tras desplegar una version nueva, al abrir la app dos veces se ve la version nueva (el SW usa skipWaiting + clientsClaim).
- [ ] Sin red, la app abre (shell precacheado) y no muestra datos de la API.
- [ ] Notificaciones push (T4.2) requieren iOS 16.4+ y la app instalada.
