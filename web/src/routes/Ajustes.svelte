<script lang="ts">
  import { onMount } from 'svelte';
  import { CALENDAR_PALETTE, isHexColor } from '@organizador/shared';
  import type { CalendarInfo, GoogleStatus } from '@organizador/shared';
  import { session, meInfo } from '../lib/auth';
  import { ApiError, logout } from '../lib/api';
  import Banner from '../components/Banner.svelte';
  import {
    duplicateColors,
    fetchCalendars,
    formatAgo,
    patchCalendar,
    refreshCalendars,
    syncErrorMessage,
    syncNow,
  } from '../lib/calendars';
  import {
    apiErrorMessage,
    connectErrorMessage,
    disconnectGoogle,
    disconnectedMessage,
    fetchGoogleStatus,
    scopeLabel,
    startGoogleConnect,
    takeGoogleResult,
  } from '../lib/google';

  let title = 'Ajustes';

  let google = $state<GoogleStatus | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let statusError = $state('');
  /** Resultado de la vuelta de Google o de una accion (connect/disconnect). */
  let notice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
  /** Vuelta correcta de Google: se reimportan los calendarios aunque ya hubiera. */
  let importAfterConnect = false;

  // --- Calendarios ---
  let calendars = $state<CalendarInfo[]>([]);
  let calLoading = $state(false);
  let calLoaded = $state(false);
  let calError = $state('');
  let calRefreshing = $state(false);
  let calNotice = $state('');
  let syncing = $state(false);
  let syncMsg = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const duplicates = $derived([...duplicateColors(calendars).values()]);

  /** Segundos restantes tras un 429 (el boton queda deshabilitado con cuenta atras). */
  let cooldown = $state(0);
  let cooldownTimer: ReturnType<typeof setInterval> | undefined;

  function startCooldown(seconds: number) {
    clearInterval(cooldownTimer);
    cooldown = seconds;
    cooldownTimer = setInterval(() => {
      cooldown -= 1;
      if (cooldown <= 0) {
        cooldown = 0;
        clearInterval(cooldownTimer);
      }
    }, 1000);
  }

  async function syncAndReload() {
    syncing = true;
    syncMsg = null;
    try {
      const res = await syncNow();
      calendars = (await fetchCalendars()).calendars;
      const withErrors = res.failed > 0 || res.partial > 0;
      syncMsg = withErrors
        ? { kind: 'error', text: 'Sincronización completada con errores.' }
        : { kind: 'ok', text: 'Sincronización completada.' };
    } catch (e) {
      syncMsg = { kind: 'error', text: syncErrorMessage(e) };
      if (e instanceof ApiError && e.status === 429) startCooldown(60);
      // Aunque falle, refresca la lista por si el estado cambio (p. ej. sync_busy).
      try {
        calendars = (await fetchCalendars()).calendars;
      } catch {
        // se mantiene la lista actual
      }
    } finally {
      syncing = false;
    }
  }

  function calendarsErrorMessage(e: unknown): string {
    if (e instanceof ApiError && e.code === 'google_not_connected') {
      return 'Google no está conectado. Vuelve a conectar para importar los calendarios.';
    }
    if (e instanceof ApiError && e.code === 'google_unavailable') {
      return 'Google no responde ahora mismo. Inténtalo de nuevo en unos minutos.';
    }
    return apiErrorMessage(e);
  }

  /** Carga la lista; si esta vacia (o se fuerza) importa desde Google una sola vez. */
  async function loadCalendars(forceImport = false) {
    calLoading = true;
    calError = '';
    try {
      let list = forceImport ? null : (await fetchCalendars()).calendars;
      if (list === null || list.length === 0) list = (await refreshCalendars()).calendars;
      calendars = list;
    } catch (e) {
      calError = calendarsErrorMessage(e);
    } finally {
      calLoading = false;
      calLoaded = true;
    }
  }

  async function refreshFromGoogle() {
    calRefreshing = true;
    calNotice = '';
    calError = '';
    try {
      calendars = (await refreshCalendars()).calendars;
      calNotice = 'Calendarios actualizados desde Google.';
    } catch (e) {
      calError = calendarsErrorMessage(e);
    } finally {
      calRefreshing = false;
    }
  }

  // Por calendario: cola de PATCH (se envian en orden), contador de version y ultimo estado
  // confirmado por el servidor, para que clics rapidos no produzcan rollbacks erroneos.
  const patchQueue: Record<string, Promise<void> | undefined> = {};
  const patchVersion: Record<string, number | undefined> = {};
  const confirmed: Record<string, { color: string; visible: boolean } | undefined> = {};

  /** Guarda en el Worker; actualiza al instante y revierte (al ultimo estado confirmado) si falla. */
  function saveCalendar(cal: CalendarInfo, patch: { color?: string; visible?: boolean }) {
    if (patch.color !== undefined && !isHexColor(patch.color)) return;
    const id = cal.id;
    confirmed[id] ??= { color: cal.color, visible: cal.visible };
    const version = (patchVersion[id] ?? 0) + 1;
    patchVersion[id] = version;
    calNotice = '';
    calError = '';
    const apply = (c: { color?: string; visible?: boolean }) => {
      calendars = calendars.map((x) => (x.id === id ? { ...x, ...c } : x));
    };
    apply(patch);
    const run = async () => {
      const latest = () => patchVersion[id] === version;
      try {
        const saved = await patchCalendar(id, patch);
        confirmed[id] = { color: saved.color, visible: saved.visible };
        // Si hay un cambio mas reciente en cola, su estado optimista prevalece.
        if (latest()) calendars = calendars.map((x) => (x.id === saved.id ? saved : x));
      } catch (e) {
        if (!latest()) return; // el cambio posterior decide el estado final
        apply(confirmed[id]!);
        calError = `No se pudo guardar el cambio en "${cal.name}". ${calendarsErrorMessage(e)}`;
      }
    };
    patchQueue[id] = (patchQueue[id] ?? Promise.resolve()).then(run);
  }

  const roleLabel = (c: CalendarInfo) =>
    c.writable ? '' : c.accessRole === 'freeBusyReader' ? 'solo ocupado/libre' : 'solo lectura';

  async function loadStatus(): Promise<boolean> {
    loading = true;
    statusError = '';
    try {
      google = await fetchGoogleStatus();
      if (google.connected && !calLoaded && !calLoading) void loadCalendars(importAfterConnect);
      return true;
    } catch (e) {
      statusError = `No se pudo obtener el estado de Google. ${apiErrorMessage(e)}`;
      return false;
    } finally {
      loading = false;
    }
  }

  async function connect() {
    busy = true;
    notice = null;
    try {
      await startGoogleConnect();
      // La pagina navega a Google: el boton sigue deshabilitado (un segundo clic pediria otro
      // ticket). Solo se reactiva si hubo error.
    } catch (e) {
      notice = { kind: 'error', text: apiErrorMessage(e) };
      busy = false;
    }
  }

  async function disconnect() {
    if (!window.confirm('¿Desconectar Google Calendar? Se revocará el acceso de la app.')) return;
    busy = true;
    notice = null;
    try {
      const { revoked } = await disconnectGoogle();
      notice = revoked
        ? { kind: 'ok', text: 'Google desconectado.' }
        : {
            kind: 'error',
            text: 'Google desconectado en la app, pero no se pudo confirmar la revocación en Google. Puedes quitar el acceso en tu cuenta de Google (Seguridad > Apps con acceso).',
          };
      await loadStatus();
    } catch (e) {
      notice = { kind: 'error', text: apiErrorMessage(e) };
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    return () => clearInterval(cooldownTimer);
  });

  onMount(() => {
    // Leer y limpiar `?google=...` del hash antes de cualquier peticion.
    const result = takeGoogleResult();
    if (result) {
      if (result.ok) {
        importAfterConnect = true;
        // `?google=ok` lo puede forjar cualquiera: solo se afirma el exito si el servidor lo confirma.
        void loadStatus().then((loaded) => {
          notice =
            loaded && google?.connected
              ? { kind: 'ok', text: 'Google conectado.' }
              : { kind: 'ok', text: 'Vuelta desde Google. Comprueba el estado de la conexión abajo.' };
        });
        return;
      }
      notice = { kind: 'error', text: connectErrorMessage(result.reason) };
    }
    void loadStatus();
  });
</script>

<div class="container">
  <h1>{title}</h1>
  <p>Configuración y preferencias.</p>
  <section aria-label="Sesión">
    <p>
      Sesión: <strong>{$session ? 'conectado' : 'sin sesión'}</strong>
      {#if $meInfo}
        <small>(servidor v{$meInfo.version}, {$meInfo.tz})</small>
      {/if}
    </p>
    <button type="button" onclick={() => logout()}>Cerrar sesión</button>
  </section>

  <section class="google" aria-labelledby="google-title" aria-busy={loading || busy}>
    <h2 id="google-title">Google Calendar</h2>

    {#if notice}
      <p
        class={notice.kind === 'ok' ? 'notice ok' : 'notice error'}
        role={notice.kind === 'ok' ? 'status' : 'alert'}
      >
        {notice.text}
      </p>
    {/if}

    {#if loading && !google}
      <p role="status">Comprobando conexión con Google...</p>
    {:else if statusError}
      <p class="notice error" role="alert">{statusError}</p>
      <button type="button" onclick={() => loadStatus()}>Reintentar</button>
    {:else if google}
      {#if !google.configured}
        <p>El servidor todavía no tiene configurada la conexión con Google.</p>
      {:else if google.connected}
        <p>Estado: <strong>Conectado</strong></p>
        {#if google.scopes.length > 0}
          <p class="muted">Permisos concedidos:</p>
          <ul class="scopes">
            {#each google.scopes as scope (scope)}
              <li>{scopeLabel(scope)}</li>
            {/each}
          </ul>
        {/if}
        {#if google.lastError}
          <p class="muted">Último error: {google.lastError}</p>
        {/if}
        <button type="button" class="secondary" disabled={busy} onclick={disconnect}>
          Desconectar Google
        </button>
      {:else}
        <p>Estado: <strong>Desconectado</strong>. {disconnectedMessage(google.reason)}</p>
        <button type="button" class="primary" disabled={busy} onclick={connect}>
          {busy ? 'Abriendo Google...' : 'Conectar Google'}
        </button>
        <p class="muted hint">
          Si al volver de Google ves una pantalla de login o una vista de navegador aparte,
          ciérrala y abre la app desde el icono; la conexión se guarda igualmente.
        </p>
      {/if}
    {/if}
  </section>

  {#if google?.connected}
    <section class="calendars" aria-labelledby="cal-title" aria-busy={calLoading || calRefreshing}>
      <h2 id="cal-title">Calendarios</h2>
      <p class="muted hint">
        Los eventos se sincronizan en ambos sentidos con Google; notas, avisos y colores se quedan
        solo en la app.
      </p>
      <button
        type="button"
        class="primary"
        disabled={calRefreshing || calLoading}
        onclick={refreshFromGoogle}
      >
        {calRefreshing ? 'Actualizando...' : 'Actualizar desde Google'}
      </button>
      <button type="button" class="primary" disabled={syncing || calLoading || cooldown > 0} onclick={syncAndReload}>
        {syncing ? 'Sincronizando...' : cooldown > 0 ? `Espera ${cooldown}s` : 'Sincronizar ahora'}
      </button>
      {#if syncMsg}
        <p class={`notice ${syncMsg.kind}`} role={syncMsg.kind === 'ok' ? 'status' : 'alert'}>
          {syncMsg.text}
        </p>
      {/if}
      {#each duplicates as names (names.join('|'))}
        <Banner kind="warning">
          Estos calendarios comparten el mismo color: {names.join(', ')}. Cambia uno para
          distinguirlos.
        </Banner>
      {/each}
      {#if calNotice}
        <p class="notice ok" role="status">{calNotice}</p>
      {/if}
      {#if calError}
        <p class="notice error" role="alert">{calError}</p>
      {/if}
      {#if calLoading && calendars.length === 0}
        <p role="status">Cargando calendarios...</p>
      {:else if calLoaded && calendars.length === 0 && !calError}
        <p class="muted">No hay calendarios.</p>
      {/if}
      {#if calendars.length > 0}
        <ul class="cal-list" aria-label="Lista de calendarios">
          {#each calendars as cal (cal.id)}
            <li class="cal">
              <div class="cal-head">
                <span class="dot" style:background-color={cal.color} aria-hidden="true"></span>
                <span class="cal-name">{cal.name}</span>
                {#if roleLabel(cal)}
                  <span class="badge">{roleLabel(cal)}</span>
                {/if}
                <label class="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={cal.visible}
                    disabled={syncing}
                    aria-label={`Mostrar ${cal.name}`}
                    onchange={(e) => saveCalendar(cal, { visible: e.currentTarget.checked })}
                  />
                  <span class="muted">{cal.visible ? 'Visible' : 'Oculto'}</span>
                </label>
              </div>
              <p class="muted sync-line">
                Última sync: {formatAgo(cal.lastSyncedAt)}
              </p>
              {#if cal.lastSyncError}
                <p class="notice error" role="alert">Error de sincronización: {cal.lastSyncError}</p>
              {/if}
              <div class="swatches" role="group" aria-label={`Color de ${cal.name}`}>
                {#each CALENDAR_PALETTE as color (color)}
                  <button
                    type="button"
                    class="swatch"
                    class:selected={cal.color.toLowerCase() === color}
                    style:background-color={color}
                    aria-label={`Color ${color} para ${cal.name}`}
                    disabled={syncing}
                    aria-pressed={cal.color.toLowerCase() === color}
                    onclick={() => saveCalendar(cal, { color })}
                  ></button>
                {/each}
                <label class="custom">
                  <span class="muted">Personalizado</span>
                  <input
                    type="color"
                    value={cal.color}
                    disabled={syncing}
                    aria-label={`Color personalizado para ${cal.name}`}
                    onchange={(e) => saveCalendar(cal, { color: e.currentTarget.value })}
                  />
                </label>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {:else if google && !google.connected && google.configured}
    <section class="calendars" aria-labelledby="cal-title">
      <h2 id="cal-title">Calendarios</h2>
      <p class="muted">Conecta Google para ver y configurar tus calendarios.</p>
    </section>
  {/if}

  <ul>
    <li>Notificaciones push</li>
    <li>Preferencias visuales</li>
    <li>Información de la app</li>
  </ul>
</div>

<style>
  .container {
    padding: 1rem;
  }

  h1 {
    margin: 0 0 1rem 0;
  }

  h2 {
    margin: 0 0 0.5rem 0;
    font-size: 1.15rem;
  }

  section {
    margin-bottom: 1.25rem;
  }

  .google {
    padding: 0.75rem 0;
    border-top: 1px solid #eee;
  }

  ul {
    list-style: none;
    padding: 0;
  }

  li {
    padding: 0.75rem;
    border-bottom: 1px solid #eee;
  }

  ul.scopes li {
    padding: 0.25rem 0.75rem;
    border-bottom: none;
  }

  small,
  .muted {
    color: #666;
  }

  .hint {
    font-size: 0.85rem;
  }

  .notice {
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
  }

  .notice.ok {
    background: #e6f4ea;
    color: #1e4620;
  }

  .notice.error {
    background: #fdecea;
    color: #8a1c13;
  }

  button {
    padding: 0.5rem 1rem;
    background-color: #757575;
    color: white;
    border: none;
    border-radius: 4px;
    min-height: 44px;
  }

  button.primary {
    background-color: #1a73e8;
  }

  button.secondary {
    background-color: #b3261e;
  }

  .calendars {
    padding: 0.75rem 0;
    border-top: 1px solid #eee;
  }

  ul.cal-list li.cal {
    padding: 0.75rem 0;
  }

  .cal-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .cal-name {
    font-weight: 600;
    flex: 1 1 8rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .dot {
    width: 1rem;
    height: 1rem;
    border-radius: 3px;
    flex: none;
    border: 1px solid rgba(0, 0, 0, 0.2);
  }

  .badge {
    font-size: 0.75rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: #eee;
    color: #444;
  }

  .switch {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 44px;
  }

  .switch input {
    width: 1.25rem;
    height: 1.25rem;
  }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.4rem;
  }

  button.swatch {
    width: 32px;
    height: 32px;
    min-height: 32px;
    padding: 0;
    border-radius: 50%;
    border: 2px solid transparent;
  }

  button.swatch.selected {
    border-color: #111;
    outline: 2px solid #fff;
    outline-offset: -4px;
  }

  .sync-line {
    margin: 0.3rem 0 0;
    font-size: 0.85rem;
  }

  .custom {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    margin-left: 0.5rem;
  }

  .custom input {
    width: 44px;
    height: 32px;
    padding: 0;
  }

  button:disabled {
    opacity: 0.6;
  }
</style>
