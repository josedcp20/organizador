<script lang="ts">
  import { onMount } from 'svelte';
  import type { GoogleStatus } from '@organizador/shared';
  import { session, meInfo } from '../lib/auth';
  import { logout } from '../lib/api';
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

  async function loadStatus(): Promise<boolean> {
    loading = true;
    statusError = '';
    try {
      google = await fetchGoogleStatus();
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
    // Leer y limpiar `?google=...` del hash antes de cualquier peticion.
    const result = takeGoogleResult();
    if (result) {
      if (result.ok) {
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

  button:disabled {
    opacity: 0.6;
  }
</style>
