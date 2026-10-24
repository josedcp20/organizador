<script lang="ts">
  import { onMount } from 'svelte';
  import { CALENDAR_PALETTE, isHexColor } from '@organizador/shared';
  import type { AppSettings, AppSettingsPatch, CalendarInfo, GoogleStatus } from '@organizador/shared';
  import { fetchSettings, patchSettings } from '../lib/settings';
  import { session, meInfo } from '../lib/auth';
  import { ApiError, logout } from '../lib/api';
  import Banner from '../components/Banner.svelte';
  import PageHeader from '../components/PageHeader.svelte';
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

  // --- Eventos (ajustes de creacion) ---
  let settings = $state<AppSettings | null>(null);
  let setError = $state('');
  let setSaving = $state(false);
  let setSaved = $state(false);
  let setRev = $state(0);
  const writableCals = $derived(calendars.filter((c) => c.writable && c.visible));

  async function loadSettings() {
    setError = '';
    try {
      settings = await fetchSettings();
    } catch (e) {
      setError = `No se pudieron cargar los ajustes de eventos. ${apiErrorMessage(e)}`;
    }
  }

  async function saveSetting(patch: AppSettingsPatch) {
    if (patch.app_events_color != null && !isHexColor(patch.app_events_color)) return;
    setSaving = true;
    setSaved = false;
    setError = '';
    try {
      settings = await patchSettings(patch);
      setSaved = true;
    } catch (e) {
      setError = `No se pudo guardar el ajuste. ${apiErrorMessage(e)}`;
      setRev++; // vuelve a montar los controles con el valor guardado

    } finally {
      setSaving = false;
    }
  }

  async function loadStatus(): Promise<boolean> {
    loading = true;
    statusError = '';
    try {
      google = await fetchGoogleStatus();
      if (google.connected && !calLoaded && !calLoading) void loadCalendars(importAfterConnect);
      if (google.connected && !settings) void loadSettings();
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

<PageHeader title="Ajustes" />

<div class="page">
  <section class="group" aria-labelledby="sesion-title">
    <h2 id="sesion-title">Sesión</h2>
    <ul class="list">
      <li class="row">
        <div class="grow">
          <p>
            Sesión: <strong>{$session ? 'conectado' : 'sin sesión'}</strong>
          </p>
          {#if $meInfo}
            <p class="muted small">Servidor v{$meInfo.version}, {$meInfo.tz}</p>
          {/if}
        </div>
        <button type="button" class="btn btn-quiet danger" onclick={() => logout()}>
          Cerrar sesión
        </button>
      </li>
    </ul>
  </section>

  <section class="group" aria-labelledby="google-title" aria-busy={loading || busy}>
    <h2 id="google-title">Google Calendar</h2>

    {#if notice}
      <Banner kind={notice.kind === 'ok' ? 'info' : 'error'}>{notice.text}</Banner>
    {/if}

    {#if loading && !google}
      <p role="status" class="muted">Comprobando conexión con Google...</p>
    {:else if statusError}
      <Banner kind="error">{statusError}</Banner>
      <button type="button" class="btn" onclick={() => loadStatus()}>Reintentar</button>
    {:else if google}
      {#if !google.configured}
        <p class="muted">El servidor todavía no tiene configurada la conexión con Google.</p>
      {:else if google.connected}
        <ul class="list">
          <li class="row">
            <span class="status ok" aria-hidden="true"></span>
            <p class="grow">Estado: <strong>Conectado</strong></p>
            <button type="button" class="btn btn-quiet danger" disabled={busy} onclick={disconnect}>
              Desconectar Google
            </button>
          </li>
          {#if google.scopes.length > 0}
            <li class="row col">
              <p class="muted small">Permisos concedidos:</p>
              <ul class="scopes">
                {#each google.scopes as scope (scope)}
                  <li>{scopeLabel(scope)}</li>
                {/each}
              </ul>
            </li>
          {/if}
          {#if google.lastError}
            <li class="row"><p class="muted small">Último error: {google.lastError}</p></li>
          {/if}
        </ul>
      {:else}
        <ul class="list">
          <li class="row">
            <span class="status off" aria-hidden="true"></span>
            <p class="grow">
              Estado: <strong>Desconectado</strong>. {disconnectedMessage(google.reason)}
            </p>
            <button type="button" class="btn btn-primary" disabled={busy} onclick={connect}>
              {busy ? 'Abriendo Google...' : 'Conectar Google'}
            </button>
          </li>
        </ul>
        <p class="help">
          Si al volver de Google ves una pantalla de login o una vista de navegador aparte,
          ciérrala y abre la app desde el icono; la conexión se guarda igualmente.
        </p>
      {/if}
    {/if}
  </section>

  {#if google?.connected}
    <section class="group" aria-labelledby="cal-title" aria-busy={calLoading || calRefreshing}>
      <h2 id="cal-title">Calendarios</h2>
      <p class="help top">
        Los eventos se sincronizan en ambos sentidos con Google; notas, avisos y colores se quedan
        solo en la app.
      </p>
      <div class="toolbar">
        <button
          type="button"
          class="btn"
          disabled={calRefreshing || calLoading}
          onclick={refreshFromGoogle}
        >
          {calRefreshing ? 'Actualizando...' : 'Actualizar desde Google'}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          disabled={syncing || calLoading || cooldown > 0}
          onclick={syncAndReload}
        >
          {syncing ? 'Sincronizando...' : cooldown > 0 ? `Espera ${cooldown}s` : 'Sincronizar ahora'}
        </button>
      </div>
      {#if syncMsg}
        <Banner kind={syncMsg.kind === 'ok' ? 'info' : 'error'}>{syncMsg.text}</Banner>
      {/if}
      {#each duplicates as names (names.join('|'))}
        <Banner kind="warning">
          Estos calendarios comparten el mismo color: {names.join(', ')}. Cambia uno para
          distinguirlos.
        </Banner>
      {/each}
      {#if calNotice}
        <Banner kind="info">{calNotice}</Banner>
      {/if}
      {#if calError}
        <Banner kind="error">{calError}</Banner>
      {/if}
      {#if calLoading && calendars.length === 0}
        <p role="status" class="muted">Cargando calendarios...</p>
      {:else if calLoaded && calendars.length === 0 && !calError}
        <p class="muted">No hay calendarios.</p>
      {/if}
      {#if calendars.length > 0}
        <ul class="list cal-list" aria-label="Lista de calendarios">
          {#each calendars as cal (cal.id)}
            <li class="cal">
              <div class="cal-head">
                <span class="dot" style:background-color={cal.color} aria-hidden="true"></span>
                <span class="cal-name">{cal.name}</span>
                {#if roleLabel(cal)}
                  <span class="pill">{roleLabel(cal)}</span>
                {/if}
                <label class="switch">
                  <span class="muted small">{cal.visible ? 'Visible' : 'Oculto'}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={cal.visible}
                    disabled={syncing}
                    aria-label={`Mostrar ${cal.name}`}
                    onchange={(e) => saveCalendar(cal, { visible: e.currentTarget.checked })}
                  />
                </label>
              </div>
              <p class="muted small">Última sync: {formatAgo(cal.lastSyncedAt)}</p>
              {#if cal.lastSyncError}
                <p class="small err" role="alert">Error de sincronización: {cal.lastSyncError}</p>
              {/if}
              <div class="swatches" role="group" aria-label={`Color de ${cal.name}`}>
                {#each CALENDAR_PALETTE as color (color)}
                  <button
                    type="button"
                    class="swatch"
                    class:selected={cal.color.toLowerCase() === color}
                    style="--c: {color}"
                    aria-label={`Color ${color} para ${cal.name}`}
                    disabled={syncing}
                    aria-pressed={cal.color.toLowerCase() === color}
                    onclick={() => saveCalendar(cal, { color })}
                  ></button>
                {/each}
                <label class="custom">
                  <span class="muted small">Personalizado</span>
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
    <section class="group" aria-labelledby="cal-title">
      <h2 id="cal-title">Calendarios</h2>
      <p class="muted">Conecta Google para ver y configurar tus calendarios.</p>
    </section>
  {/if}

  {#if google?.connected}
  <section class="group" aria-labelledby="ev-title" aria-busy={setSaving || (!settings && !setError)}>
    <h2 id="ev-title">Eventos</h2>
    {#if setError}
      <Banner kind="error">{setError}</Banner>
      {#if !settings}
        <button type="button" class="btn" onclick={() => loadSettings()}>Reintentar</button>
      {/if}
    {:else if setSaved}
      <Banner kind="info">Ajuste guardado.</Banner>
    {/if}
    {#if !settings && !setError}
      <p role="status" class="muted">Cargando ajustes...</p>
    {:else if settings}
      {#key setRev}
      <div class="fields">
        <label class="field">
          <span>Calendario para nuevos eventos</span>
          <select
            disabled={setSaving}
            value={settings.default_write_calendar ?? ''}
            onchange={(e) => saveSetting({ default_write_calendar: e.currentTarget.value || null })}
          >
            <option value="">Sin preferencia</option>
            {#each writableCals as cal (cal.id)}
              <option value={cal.id}>{cal.name}</option>
            {/each}
          </select>
        </label>
        <div class="field" role="group" aria-label="Color de eventos creados en la app">
          <span>Color de eventos creados en la app</span>
          <div class="swatches">
            <button
              type="button"
              class="btn btn-quiet"
              aria-pressed={settings.app_events_color === null}
              disabled={setSaving}
              onclick={() => saveSetting({ app_events_color: null })}>Color del calendario</button
            >
            {#each CALENDAR_PALETTE as color (color)}
              <button
                type="button"
                class="swatch"
                class:selected={settings.app_events_color === color}
                style="--c: {color}"
                aria-label={`Color ${color} para eventos de la app`}
                aria-pressed={settings.app_events_color === color}
                disabled={setSaving}
                onclick={() => saveSetting({ app_events_color: color })}
              ></button>
            {/each}
            <label class="custom">
              <span class="muted small">Personalizado</span>
              <input
                type="color"
                value={settings.app_events_color ?? '#1a73e8'}
                disabled={setSaving}
                aria-label="Color personalizado para eventos de la app"
                onchange={(e) => saveSetting({ app_events_color: e.currentTarget.value })}
              />
            </label>
          </div>
        </div>
      </div>
      {/key}
    {/if}
  </section>
  {/if}

  <section class="group" aria-labelledby="more-title">
    <h2 id="more-title">Más ajustes</h2>
    <ul class="list soon">
      <li class="row"><span class="grow">Notificaciones push</span><span class="small">Próximamente</span></li>
      <li class="row"><span class="grow">Preferencias visuales</span><span class="small">Próximamente</span></li>
      <li class="row"><span class="grow">Información de la app</span><span class="small">Próximamente</span></li>
    </ul>
  </section>
</div>

<style>
  .page {
    display: grid;
    gap: var(--sp-6);
  }
  .group h2 {
    font-size: var(--fs-l);
    margin: 0 0 var(--sp-2) var(--sp-1);
  }
  .group > :global(.banner),
  .group > .toolbar,
  .group > .btn {
    margin-bottom: var(--sp-3);
  }
  .help {
    margin: var(--sp-2) var(--sp-4) 0;
    font-size: var(--fs-s);
    color: var(--ink-2);
  }
  .help.top {
    margin: 0 var(--sp-1) var(--sp-3);
  }
  .small {
    font-size: var(--fs-s);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-3);
    min-height: var(--tap);
    padding: var(--sp-2) var(--sp-4);
  }
  .row.col {
    flex-direction: column;
    flex-wrap: nowrap;
    align-items: flex-start;
    gap: var(--sp-1);
  }
  .grow {
    flex: 1 1 12rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .soon .row {
    color: var(--ink-2);
  }
  .scopes {
    list-style: none;
    padding: 0;
    font-size: var(--fs-s);
  }
  .scopes li {
    max-width: none;
  }
  .status {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .status.ok {
    background: var(--ok);
  }
  .status.off {
    background: var(--ink-2);
  }
  .danger {
    color: var(--danger);
  }
  .danger:hover {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .err {
    color: var(--danger);
    margin-top: var(--sp-1);
  }

  .fields {
    display: grid;
    gap: var(--sp-4);
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-m);
    background: var(--surface);
  }
  .field {
    display: grid;
    gap: var(--sp-1);
    font-weight: 600;
  }
  /* iOS: etiqueta a la izquierda, selector a la derecha */
  @media (hover: none) and (pointer: coarse) {
    label.field {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-3);
    }
    label.field > select {
      max-width: 55%;
    }
  }

  .cal {
    padding: var(--sp-3) var(--sp-4);
  }
  .cal-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-3);
  }
  .dot {
    flex: none;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.18);
  }
  .cal-name {
    flex: 1 1 10rem;
    min-width: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .pill {
    flex: none;
    padding: 0 var(--sp-2);
    border-radius: 999px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    color: var(--ink-2);
    font-size: var(--fs-xs);
  }
  .switch {
    flex: none;
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: var(--tap);
    font-weight: 400;
  }
  /* Interruptor estilo iOS sobre el checkbox role=switch */
  .switch input {
    appearance: none;
    position: relative;
    flex: none;
    width: 51px;
    height: 31px;
    margin: 0;
    border-radius: 999px;
    background: var(--ink-2);
    cursor: pointer;
    transition: background-color var(--dur) var(--ease);
  }
  .switch input::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    border-radius: 50%;
    background: var(--surface);
    transition: transform var(--dur) var(--ease);
  }
  .switch input:checked {
    background: var(--ok);
  }
  .switch input:checked::after {
    transform: translateX(20px);
  }
  .switch input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .swatches {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    margin: var(--sp-1) calc(-1 * var(--sp-2)) 0;
  }
  /* Objetivo de 44px; el circulo visible es el pseudo-elemento */
  .swatch {
    position: relative;
    width: var(--tap);
    height: var(--tap);
    padding: 0;
    border: 0;
    background: none;
  }
  .swatch::before {
    content: '';
    position: absolute;
    inset: 8px;
    border-radius: 50%;
    background: var(--c);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.18);
  }
  .swatch.selected::before {
    box-shadow:
      0 0 0 2px var(--surface),
      0 0 0 4px var(--ink);
  }
  .swatch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .custom {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    margin-left: var(--sp-2);
    font-weight: 400;
  }
  .custom input {
    width: var(--tap);
    height: var(--tap);
    padding: 0;
  }

  @media (min-width: 1024px) {
    .cal-list {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--sp-3);
      background: none;
    }
    .cal-list > li {
      background: var(--surface);
      border-radius: var(--r-m);
    }
    .cal-list > li + li {
      border-top: 0;
    }
  }
</style>
