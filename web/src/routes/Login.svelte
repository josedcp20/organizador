<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch, ApiError } from '../lib/api';
  import { setToken, meInfo, takeReturnTo } from '../lib/auth';
  import { getQueryParams, navigateTo } from '../router';

  let tokenInput = $state('');
  let error = $state('');
  let loading = $state(false);

  function messageFor(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.status === 401) return 'Token no válido. Revísalo e inténtalo de nuevo.';
      if (e.status === 429) {
        const mins = e.retryAfter ? Math.ceil(e.retryAfter / 60) : undefined;
        return `Demasiados intentos fallidos: acceso bloqueado temporalmente${
          mins ? `. Vuelve a probar en unos ${mins} min` : ''
        }.`;
      }
      if (e.code === 'network') return 'Error de conexión: no se pudo contactar con el servidor.';
      if (e.code === 'config') return 'La app no está configurada (falta la URL del servidor).';
      return `Error del servidor (${e.status}).`;
    }
    return 'Error inesperado.';
  }

  async function attempt(token: string) {
    loading = true;
    error = '';
    try {
      const me = await apiFetch<{ version: string; tz: string }>('/api/me', { token });
      setToken(token);
      meInfo.set({ version: String(me.version), tz: String(me.tz) });
      tokenInput = '';
      navigateTo(takeReturnTo() === 'nota-rapida' ? 'nota-rapida' : 'hoy');
    } catch (e) {
      error = messageFor(e);
    } finally {
      loading = false;
    }
  }

  async function handleSubmit(event: Event) {
    event.preventDefault();
    const token = tokenInput.trim();
    if (!token) {
      error = 'Introduce el token.';
      return;
    }
    await attempt(token);
  }

  onMount(() => {
    const fromUrl = getQueryParams().get('token');
    if (fromUrl === null) return;
    // Quitar el token de la URL/historial antes de nada (valido o no).
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', `${pathname}${search}#/login`);
    const token = fromUrl.trim();
    if (token) void attempt(token);
  });
</script>

<div class="login-container">
  <h1><span class="mark">Organizador</span></h1>
  <form onsubmit={handleSubmit} autocomplete="off">
    <label for="token">Token de acceso</label>
    <input
      id="token"
      name="token"
      type="password"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      bind:value={tokenInput}
      aria-describedby={error ? 'login-error' : undefined}
    />
    <button type="submit" class="btn btn-primary" disabled={loading}>{loading ? 'Comprobando...' : 'Entrar'}</button>
    {#if error}
      <p id="login-error" class="error" role="alert">{error}</p>
    {/if}
  </form>
</div>

<style>
  .login-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    gap: var(--sp-5);
    padding: var(--sp-5) var(--sp-4);
  }

  h1 {
    font-size: var(--fs-display);
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    width: 100%;
    max-width: 22rem;
    padding: var(--sp-5);
    border-radius: var(--r-m);
    background: var(--surface);
  }

  .error {
    color: var(--danger);
    font-size: var(--fs-s);
  }
</style>
