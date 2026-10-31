# Instalar Organizador en iPhone

1. Abre Safari (no Chrome) y entra en la URL de la app (`https://<usuario>.github.io/organizador/`).
2. Pulsa Compartir y elige "Anadir a pantalla de inicio".
3. Confirma el nombre "Organizador" y pulsa "Anadir".
4. Abre la app desde el icono de la pantalla de inicio: debe abrirse a pantalla completa (standalone), sin barra de Safari.

## Notificaciones

Requieren iOS 16.4 o superior y la app instalada en la pantalla de inicio (en Safari normal no hay push).

1. Abre la app desde el icono, entra en Ajustes > Notificaciones y pulsa "Activar". Acepta el permiso de iOS.
2. Pulsa "Enviar prueba": debe llegar una notificacion "Notificación de prueba".
3. Previsualizaciones: en Ajustes de iOS > Notificaciones > Organizador, deja "Mostrar previsualizaciones" en "Cuando esté desbloqueado" para ver el texto del resumen sin exponerlo con la pantalla bloqueada.
4. Focus / No molestar: anade Organizador a las apps permitidas del Focus que uses, o el resumen de las 8:00 no sonara.

### Plan B: Atajo de iOS a las 8:00

Si el push no llega, un Atajo puede mostrar el mismo resumen:

1. Atajos > Automatizacion > Hora del dia: 8:00, "Ejecutar inmediatamente".
2. Accion "Obtener contenido de URL": URL `https://<tu-worker>/api/digest?format=text`, metodo GET, cabecera `Authorization` con valor `Bearer <tu token>` (el mismo que usas en el Atajo de notas rapidas; no lo compartas ni lo guardes en el repositorio).
3. Accion "Mostrar notificacion" con el resultado del paso anterior.

`?format=json` devuelve `{ title, body, url, tag, text }`. La respuesta nunca incluye notas, descripcion ni ubicacion de los eventos.

## Comprobaciones manuales (no automatizables)

- [ ] El icono en la pantalla de inicio es el calendario/check azul (no una captura de la pagina).
- [ ] La app abre en modo standalone, sin barra de direcciones.
- [ ] Tras desplegar una version nueva, al abrir la app dos veces se ve la version nueva (el SW usa skipWaiting + clientsClaim).
- [ ] Sin red, la app abre (shell precacheado) y no muestra datos de la API.
- [ ] Notificaciones push (T4.2) requieren iOS 16.4+ y la app instalada.
