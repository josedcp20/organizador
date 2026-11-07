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

## Widget de pantalla de bloqueo (Scriptable)

Muestra el siguiente evento, pendientes de hoy, notas rapidas y avisos proximamente.

1. Descarga la app **Scriptable** desde App Store (gratis).
2. Abre Scriptable y crea un nuevo script (boton `+`).
3. Pega el contenido de `scriptable/organizador-widget.js` (descargalo desde GitHub, seccion "Raw" del archivo). Guarda el script con un nombre (p. ej. "Organizador").
4. Ejecuta el script dentro de la app (boton play): apareceran opciones "Vista previa", "Configurar token" y "Borrar token". Pulsa "Configurar token" e introduce el token maestro de la app (el mismo que usas en el login); se guarda en el Keychain y no se vuelve a pedir.
5. Prueba con "Vista previa" (elige tamaño p. ej. Medium).
6. Anadir widget: en la pantalla de inicio o de bloqueo, mantén pulsado una zona vacia, toca `+`, busca Scriptable, selecciona el script "Organizador" y elige el tamaño.

Tamanios soportados:

- **Pantalla de bloqueo**: `accessoryInline` (texto de una linea), `accessoryCircular` (numero), `accessoryRectangular` (3 lineas).
- **Pantalla de inicio**: `small`, `medium`, `large`.

**Importante**: iOS decide cuando refresca el widget (puede tardar 15-60 min o mas segun bateria y uso). La marca de antiguedad (p. ej. "hace 20 min") se actualiza sola sin relanzar el script. Para forzar una actualizacion, abre el script en Scriptable y ejecutalo. **Tocar el widget abre Scriptable**, no la app.

Si el token expira o es incorrecto, el widget para de llamar a la API tras el primer error (401/403) para no bloquear la IP del iPhone (ver "Seguridad y rotacion de token" abajo).

## Atajo de nota rapida con toque trasero

Crea una nota rapidamente diciendo un texto o escribiendolo, asignado al doble toque trasero del iPhone.

**Crear el Atajo:**

1. Abre la app **Atajos** (Shortcuts).
2. Crea un nuevo atajo (boton `+`).
3. Anade la accion "Pedir entrada":
   - Tipo: Texto.
   - Pregunta: "Nota" (o similar).
   - El teclado incluye un microfono para dictar; alternativa: reemplazar con accion "Dictar texto".
4. Anade la accion "Obtener contenido de URL":
   - **URL**: `https://organizador-api.jose-dcp20.workers.dev/api/quick-notes?expiry=today` (ajusta `expiry` si lo necesitas: `3` para 3 dias, `forever` para siempre; por defecto `today` caduca a las 00:00).
   - **Metodo**: POST.
   - **Cabeceras**:
     - `Authorization`: `Bearer <tu token maestro>`
     - `Content-Type`: `text/plain`
   - **Cuerpo de la solicitud**: **Archivo** = variable "Entrada proporcionada" (del paso 3).

   **Critico**: usa **"Archivo"**, no "Formulario" (si usas Formulario, se guardaria literalmente `entrada=texto%20codificado`).

   Si hay problemas: alternativa con **Cuerpo JSON**: utiliza un diccionario JSON con clave `body` = entrada; la respuesta sera JSON y debes mostrar un texto fijo en la notificacion.

5. Anade la accion "Mostrar notificacion":
   - Titulo: (vacio o "Guardada").
   - Texto: "Contenido de la URL" (variable del paso 4): mostrara "Guardada (caduca el DD/MM a las HH:mm)" o similar.

6. Guarda el Atajo con un nombre (p. ej. "Nota rapida").

**Asignar al Toque trasero:**

1. Abre Ajustes > Accesibilidad.
2. Baja hasta "Tocar" y abre "Toque posterior" (Back Tap).
3. Toca "Doble toque" (o "Triple toque" si lo prefieres).
4. Selecciona "Atajos" y elige el atajo "Nota rapida".

Funciona con el iPhone desbloqueado: doble toque en la parte trasera -> dicta/escribe la nota -> notificacion con confirmacion -> aparece en la app (Notas).

## Seguridad y rotacion de token

- **No compartas el Atajo por iCloud** (un enlace compartido expone el token en claro; lo mismo con capturas de pantalla de la accion).
- **Rotacion de token**: si regeneras el token maestro (`npm run gen:token -w worker`), debes actualizar:
  1. Scriptable: abre el script, pulsa "Configurar token" e introduce el nuevo token.
  2. Atajo de las 8:00 (si lo usas): edita la cabecera `Authorization` con el nuevo token.
  3. Atajo de nota rapida: edita la cabecera `Authorization` con el nuevo token.

  **Hazlo seguido**: un Atajo/widget con token viejo cuenta fallos de autenticacion. 10 fallos en 15 min bloquean la IP durante 15 min (afecta tambien a la PWA en el mismo iPhone/red y wifi). El widget deja de pedir tras el primer 401/403 para evitar acumular fallos; los Atajos no, asi que actualiza rapidamente.

- **Revocar sin sustituir**: si necesitas desactivar el token sin tener sustituto, borra `DEVICE_TOKEN_SHA256` (si existe) o regenera el `APP_TOKEN_SHA256` maestro. La PWA sigue funcionando (solo caduca la sesion de 30 dias si la hay).

## Comprobaciones manuales (no automatizables)

**Instalacion y notificaciones:**

- [ ] El icono en la pantalla de inicio es el calendario/check azul (no una captura de la pagina).
- [ ] La app abre en modo standalone, sin barra de direcciones.
- [ ] Tras desplegar una version nueva, al abrir la app dos veces se ve la version nueva (el SW usa skipWaiting + clientsClaim).
- [ ] Sin red, la app abre (shell precacheado) y no muestra datos de la API.
- [ ] Notificaciones push (T4.2) requieren iOS 16.4+ y la app instalada.

**Widget Scriptable:**

- [ ] Ejecutar el script en Scriptable la primera vez pide el token; reabrirlo no lo vuelve a pedir.
- [ ] Widget visible en pantalla de bloqueo (rectangular e inline) y pantalla de inicio (small/medium).
- [ ] Widget muestra el siguiente evento de hoy con su hora.
- [ ] Marcar un evento como hecho en la PWA; tras el siguiente refresco de iOS (o ejecutar el script) aparece marcado en el widget.
- [ ] Modo avion: el widget muestra el ultimo dato con marca de antiguedad "hace X min" (se actualiza sola).
- [ ] Token incorrecto en Scriptable: tras el primer error (401), el widget deja de llamar a la API (comprobar con `wrangler tail` que no hay mas peticiones) y no se bloquea la IP.

**Atajo de nota rapida:**

- [ ] Doble toque trasero -> dictar "prueba" -> notificacion "Guardada (caduca el DD/MM a las 00:00)" -> la nota aparece en la PWA (Notas) con el texto exacto (sin `=`, sin `%20`, sin comillas).
- [ ] Nota con acentos y emoji (p. ej. "Reunion con Jose a las 15h ☺️") llega bien en UTF-8.
- [ ] Token incorrecto en el Atajo: respuesta 401 o 403 en la notificacion; token incorrecto en 10 intentos en 15 min bloquea la IP (incluso PWA) 15 min.
