# Google Cloud: OAuth para Google Calendar

Pasos manuales (una sola vez) para que el boton **Conectar Google** de Ajustes funcione. Todo es
gratuito: no hace falta facturacion ni verificar la app.

La app pide **exactamente** estos permisos (constante `GOOGLE_SCOPES` en
`worker/src/google/oauth.ts`):

- `https://www.googleapis.com/auth/calendar.events`: ver y editar eventos.
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`: ver la lista de calendarios
  (solo lectura). Se quitara si el spike T2.1 demuestra que no hace falta (decision D11).

**Nunca** `https://www.googleapis.com/auth/calendar` (acceso completo). Si Google concede permisos
de mas, el Worker revoca el token y rechaza la conexion; si falta el de eventos, la rechaza.

## 1. Proyecto y API (M4-M5)

1. Entra en <https://console.cloud.google.com> con tu cuenta y crea el proyecto `organizador`
   (sin cuenta de facturacion).
2. APIs y servicios > Biblioteca > **Google Calendar API** > Habilitar.

## 2. Pantalla de consentimiento (M6)

En **Google Auth Platform** (antes "Pantalla de consentimiento OAuth"):

1. Tipo de usuario **External**.
2. Nombre de la app (`Organizador`), email de soporte y de contacto: tu cuenta. Dominio autorizado:
   dejalo vacio (`workers.dev` no se puede verificar).
3. **Data access** > Add or remove scopes: anade **solo**
   `.../auth/calendar.events` y `.../auth/calendar.calendarlist.readonly`. No anadas
   `.../auth/calendar` ni ningun otro.
4. **Audience**: anade tu propio email como test user (temporal, hasta publicar).

Al conectar, deja marcadas todas las casillas que muestre Google: si desmarcas la de eventos, la app
rechaza la conexion ("Necesitamos permiso para ver y editar eventos").

## 3. Cliente OAuth (M7)

Clients > Create client > **Web application**, con estas URI de redireccion autorizadas (exactas):

- `https://organizador-api.jose-dcp20.workers.dev/oauth/google/callback`
- `http://localhost:8787/oauth/google/callback` (solo desarrollo local)

Copia el **Client ID** y el **Client secret** (el secret solo se muestra una vez; si lo pierdes,
crea otro en el mismo cliente).

La URI de produccion esta en `worker/wrangler.toml` (`[vars] GOOGLE_REDIRECT_URI`) y debe coincidir
caracter a caracter con la registrada. En local se sobrescribe en `worker/.dev.vars`.

## 4. Publicar la app (M8)

Audience > **Publish app** -> estado **In production**. No pidas verificacion. Al conectar veras
"Google no ha verificado esta app": pulsa Avanzado > Ir a Organizador.

Importante: en estado **Testing** los refresh tokens caducan a los 7 dias. Confirma que esta en
"In production" antes de conectar; si conectaste en Testing, vuelve a conectar despues de publicar.

## 5. Secretos del Worker

Desde `worker/` (con `npx wrangler login` hecho). Cada comando pide el valor por teclado: pegalo y
pulsa Enter. Los valores nunca van al repo ni a GitHub.

1. Genera las dos claves aleatorias (solo se imprimen en consola, no se guardan en disco):

   ```bash
   npm run gen:secrets -w worker
   ```

2. Carga los cuatro secretos:

   ```bash
   cd worker
   npx wrangler secret put GOOGLE_CLIENT_ID       # Client ID del paso 3
   npx wrangler secret put GOOGLE_CLIENT_SECRET   # Client secret del paso 3
   npx wrangler secret put TOKEN_ENC_KEY          # de gen:secrets (cifra el refresh token en D1)
   npx wrangler secret put OAUTH_STATE_KEY        # de gen:secrets (firma tickets y state)
   ```

3. Comprueba con `npx wrangler secret list` que aparecen (junto a `APP_TOKEN_SHA256`).

Mientras falte cualquiera de ellos el Worker **falla en cerrado**: Ajustes muestra "El servidor
todavia no tiene configurada la conexion con Google" y no se inicia ningun flujo.

Notas:

- `TOKEN_ENC_KEY` debe decodificar a exactamente 32 bytes y `OAUTH_STATE_KEY` a 32 o mas.
- Cambiar `TOKEN_ENC_KEY` deja ilegible el refresh token guardado: hay que volver a conectar Google.
- Cambiar `OAUTH_STATE_KEY` solo invalida conexiones a medio hacer (tickets de 60 s, state de 10 min).
- No hace falta redesplegar tras `wrangler secret put`: el secreto se aplica al Worker desplegado.

### Desarrollo local

Copia `worker/.dev.vars.example` a `worker/.dev.vars` y rellena `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` y claves **distintas** de las de produccion (`npm run gen:secrets -w worker`).
El ejemplo ya fija `GOOGLE_REDIRECT_URI=http://localhost:8787/oauth/google/callback` y
`APP_URL=http://localhost:5173/organizador/`.

## 6. Conectar

1. En la app: Ajustes > Google Calendar > **Conectar Google**.
2. La app pide al Worker un ticket de un solo uso (60 s) y abre
   `https://organizador-api.jose-dcp20.workers.dev/oauth/google/start?ticket=...`, que redirige a
   Google.
3. Tras aceptar, Google vuelve a `/oauth/google/callback` y el Worker te devuelve a
   `https://josedcp20.github.io/organizador/#/ajustes?google=ok` (o `google=error&reason=...`).

Si Google revoca el acceso (`invalid_grant`), Ajustes muestra "Desconectado" con el motivo y basta con
volver a pulsar **Conectar Google**. **Desconectar Google** revoca el token en Google y borra las
credenciales de D1; si la revocacion no se pudo confirmar, quita el acceso a mano en
<https://myaccount.google.com/permissions>.

### iOS (PWA instalada)

Si al volver de Google ves una pantalla de login o una vista de navegador aparte, cierrala y abre la
app desde el icono; la conexion se guarda igualmente.

## 7. Notas de seguridad y puntos a confirmar

- **Scope en el refresh (confirmar en T2.1 con cuenta real):** el Worker revalida el scope en cada
  refresh y es fail-closed. Si Google no devolviera `scope` en la respuesta del refresh, el codigo
  revocaria y marcaria la conexion como `scope_mismatch`. Confirmar con la cuenta real que el refresh
  lo devuelve; si no, relajar esa comprobacion solo en el refresh.
- **`state` no ligado al navegador (riesgo aceptado):** el `state` es firmado y de un solo uso, pero no
  va atado a una cookie del navegador. Si se filtrase la URL de consentimiento, un tercero podria
  conectar SU cuenta de Google en esta app. Riesgo aceptado: un solo usuario, el ticket dura 60 s y el
  `state` 10 min.
- **Scope extra:** si Google concede un permiso de mas, el Worker revoca; como la revocacion invalida
  toda la concesion de la app, una conexion previa tambien queda desconectada (`scope_mismatch`) y hay
  que reconectar.
- **Credenciales ilegibles:** si se cambia `TOKEN_ENC_KEY` (o la fila se manipula), Ajustes muestra
  "Desconectado" (motivo `unreadable`); reconectar. Restaurando la clave correcta se recupera sola.
