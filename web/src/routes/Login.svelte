<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch, ApiError } from '../lib/api';
  import { setToken, meInfo, takeReturnTo, type MeInfo } from '../lib/auth';
  import { getQueryParams, navigateTo } from '../router';
  import {
    passkeySupported,
    platformAvailable,
    fetchLoginOptions,
    authenticatePasskey,
    loginWithPasskey,
    PasskeyError,
    type LoginOptionsJSON,
  } from '../lib/passkeys';

  const OPTIONS_TTL_MS = 4 * 60 * 1000; // el servidor las caduca a los 5 min

  let tokenInput = $state('');
  let error = $state('');
  let loading = $state(false);
  let faceAvailable = $state(false);
  let faceBusy = $state(false);
  let notice = $state('');
  let faceOptions: { options: LoginOptionsJSON; at: number } | null = null;
  let preloading: Promise<void> | null = null;

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

  const optionsFresh = () => faceOptions !== null && Date.now() - faceOptions.at < OPTIONS_TTL_MS;

  // Las opciones se piden antes del toque: iOS exige credentials.get dentro del gesto.
  function preload(): Promise<void> {
    preloading ??= fetchLoginOptions()
      .then((options) => {
        faceOptions = { options, at: Date.now() };
      })
      .catch(() => {
        faceOptions = null;
      })
      .finally(() => {
        preloading = null;
      });
    return preloading;
  }

  function faceMessage(e: unknown): string {
    if (e instanceof ApiError && e.status === 401) {
      return 'Passkey no reconocida (quizá revocada). Entra con el token.';
    }
    if (e instanceof PasskeyError) return e.message;
    return messageFor(e);
  }

  // Sin awaits antes de authenticatePasskey: debe ejecutarse dentro del gesto del toque.
  async function faceLogin() {
    const stored = faceOptions;
    error = '';
    notice = '';
    if (!stored || !optionsFresh()) {
      faceOptions = null;
      void preload();
      notice = 'Preparando Face ID. Vuelve a pulsar el botón en un momento.';
      return;
    }
    faceOptions = null; // el challenge es de un solo uso
    faceBusy = true;
    try {
      const response = await authenticatePasskey(stored.options);
      const { token } = await loginWithPasskey(response);
      await attempt(token);
    } catch (e) {
      if (e instanceof PasskeyError && e.code === 'cancelled') notice = e.message;
      else error = faceMessage(e);
      void preload();
    } finally {
      faceBusy = false;
    }
  }

  async function attempt(token: string) {
    loading = true;
    error = '';
    try {
      const me = await apiFetch<MeInfo>('/api/me', { token });
      setToken(token);
      meInfo.set({
        version: String(me.version),
        tz: String(me.tz),
        ...(me.auth ? { auth: me.auth } : {}),
        ...(me.sessionExpiresAt ? { sessionExpiresAt: me.sessionExpiresAt } : {}),
      });
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
    if (passkeySupported()) {
      void platformAvailable().then((ok) => {
        faceAvailable = ok;
        if (ok) void preload();
      });
    }
    const onVisible = () => {
      if (faceAvailable && document.visibilityState === 'visible' && !optionsFresh()) void preload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

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
  {#if faceAvailable}
    <div class="face">
      <button type="button" class="btn btn-primary" onclick={faceLogin} disabled={faceBusy || loading} aria-busy={faceBusy}>
        {faceBusy ? 'Comprobando...' : 'Entrar con Face ID'}
      </button>
      {#if notice}
        <p class="notice" role="status">{notice}</p>
      {/if}
    </div>
  {/if}
  <form onsubmit={handleSubmit} autocomplete="off">
    {#if faceAvailable}<p class="alt">Usar token</p>{/if}
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

  .face {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    width: 100%;
    max-width: 22rem;
  }

  .alt,
  .notice {
    font-size: var(--fs-s);
    color: var(--ink-2);
  }

  .error {
    color: var(--danger);
    font-size: var(--fs-s);
  }
</style>
