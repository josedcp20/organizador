<script lang="ts">
  /* global NotificationPermission */
  import { onDestroy, onMount } from 'svelte';
  import type { PushStatusResponse, PushSubscriptionInfo } from '@organizador/shared';
  import { ApiError } from '../lib/api';
  import {
    disablePush,
    enablePush,
    fetchPushStatus,
    hasLocalSubscription,
    isPushEnabledHere,
    localPushId,
    pushSupport,
    removePushDevice,
    sendDigestNow,
    sendTestPush,
  } from '../lib/push';

  // Minimo del spike (T1.6); T4.8 lo completa (estado del resumen, cuenta atras...).
  const support = pushSupport();
  let status = $state<PushStatusResponse | null>(null);
  let permission = $state<NotificationPermission>(
    support === 'ok' ? Notification.permission : 'default',
  );
  let active = $state(false);
  let busy = $state(false);
  let message = $state('');
  let error = $state('');

  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : 'nunca';

  let cooldown = $state(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  function startCooldown(sec: number) {
    cooldown = sec;
    clearInterval(timer);
    timer = setInterval(() => {
      cooldown = Math.max(0, cooldown - 1);
      if (cooldown === 0) clearInterval(timer);
    }, 1000);
  }
  onDestroy(() => clearInterval(timer));

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Europe/Madrid',
    });

  const digestText = $derived.by(() => {
    const d = status?.digest;
    if (!d) return '';
    const why = d.lastError ? ` (${d.lastError})` : '';
    if (d.status === 'sent')
      return `Resumen de hoy: enviado a las ${d.sentAt ? fmtTime(d.sentAt) : '--:--'}.`;
    if (d.status === 'failed') return `Resumen de hoy: fallido${why}; se reintentará.`;
    if (d.status === 'gave_up') return `Resumen de hoy: abandonado tras ${d.attempts} intentos${why}.`;
    if (d.status === 'no_subscriptions') return 'Resumen de hoy: sin suscripciones, no se envió.';
    return 'Resumen de hoy: pendiente de envío.';
  });

  const errText = (e: unknown) =>
    e instanceof ApiError
      ? e.status === 429
        ? `Espera ${e.retryAfter ?? 30} s antes de otra prueba.`
        : e.message
      : e instanceof Error
        ? e.message
        : 'No se pudo completar la operación.';

  async function load() {
    try {
      status = await fetchPushStatus();
      active = isPushEnabledHere() && permission === 'granted' && (await hasLocalSubscription());
    } catch (e) {
      error = `No se pudo cargar el estado de las notificaciones. ${errText(e)}`;
    }
  }

  function activate() {
    const key = status?.publicKey;
    if (!key) return;
    // enablePush llama a requestPermission como primera instruccion (gesto del usuario).
    const p = enablePush(key);
    busy = true;
    message = '';
    error = '';
    void p
      .then(async (perm) => {
        permission = perm;
        if (perm === 'granted') {
          active = true;
          message = 'Notificaciones activadas en este dispositivo.';
          await load();
        }
      })
      .catch((e) => (error = `No se pudieron activar. ${errText(e)}`))
      .finally(() => (busy = false));
  }

  async function deactivate() {
    busy = true;
    message = '';
    error = '';
    try {
      await disablePush();
      active = false;
      message = 'Notificaciones desactivadas en este dispositivo.';
      await load();
    } catch (e) {
      error = errText(e);
    } finally {
      busy = false;
    }
  }

  async function send(what: 'test' | 'digest') {
    busy = true;
    message = '';
    error = '';
    try {
      const r = await (what === 'test' ? sendTestPush() : sendDigestNow());
      const n = `${r.sent} dispositivo${r.sent === 1 ? '' : 's'}`;
      message =
        r.sent > 0
          ? `${what === 'test' ? 'Prueba enviada' : 'Enviado'} a ${n}.`
          : `No se pudo entregar ${what === 'test' ? 'la prueba' : 'el resumen'} a ningún dispositivo.`;
      if (r.failed || r.removed) await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) startCooldown(e.retryAfter ?? 30);
      error = errText(e);
    } finally {
      busy = false;
    }
  }

  async function remove(s: PushSubscriptionInfo) {
    if (!window.confirm(`¿Quitar "${s.label}" de las notificaciones?`)) return;
    // Este dispositivo: desactivacion completa, o syncPushOnOpen lo volveria a suscribir.
    if (s.id === localPushId()) return deactivate();
    busy = true;
    error = '';
    try {
      await removePushDevice(s.id);
      await load();
    } catch (e) {
      error = errText(e);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    if (support === 'ok') void load();
  });
</script>

<section class="group" aria-labelledby="push-title" aria-busy={busy}>
  <h2 id="push-title">Notificaciones push</h2>
  <div aria-live="polite">
    {#if message}<p class="msg">{message}</p>{/if}
    {#if error}<p class="msg err" role="alert">{error}</p>{/if}
  </div>
  {#if support === 'ios-not-installed'}
    <p class="help">
      En iPhone las notificaciones solo funcionan con la app instalada: en Safari pulsa Compartir →
      «Añadir a pantalla de inicio», abre Organizador desde el icono e inicia sesión allí.
    </p>
  {:else if support === 'unsupported'}
    <p class="help">Este navegador no admite notificaciones push.</p>
  {:else if status && !status.configured}
    <p class="help">El servidor todavía no tiene configuradas las notificaciones.</p>
  {:else if permission === 'denied'}
    <p class="help">
      Las notificaciones están bloqueadas. En iPhone: Ajustes → Notificaciones → Organizador →
      Permitir notificaciones. En el ordenador: permisos del sitio en el navegador.
    </p>
  {:else if active}
    <p class="help">Activadas en este dispositivo. Resumen diario a las 8:00.</p>
    <div class="actions">
      <button type="button" class="btn btn-primary" disabled={busy || cooldown > 0} onclick={() => send('test')}
        >Enviar prueba{cooldown > 0 ? ` (${cooldown} s)` : ''}</button
      >
      <button
        type="button"
        class="btn btn-quiet"
        disabled={busy || cooldown > 0}
        onclick={() => send('digest')}
        >Enviar resumen ahora{cooldown > 0 ? ` (${cooldown} s)` : ''}</button
      >
      <button type="button" class="btn btn-quiet" disabled={busy} onclick={deactivate}>Desactivar</button>
    </div>
  {:else}
    <p class="help">Recibe el resumen diario a las 8:00 y los avisos de tus eventos.</p>
    <button
      type="button"
      class="btn btn-primary"
      disabled={busy || !status?.publicKey}
      onclick={activate}>Activar notificaciones</button
    >
  {/if}
  {#if digestText}<p class="help" data-testid="digest-status">{digestText}</p>{/if}
  {#if status && status.subscriptions.length > 0}
    <ul class="list" aria-label="Dispositivos con notificaciones">
      {#each status.subscriptions as s (s.id)}
        <li class="row">
          <div class="grow">
            <p><strong>{s.label}</strong>{s.id === localPushId() ? ' · Este dispositivo' : ''}</p>
            <p class="muted small">
              Último envío correcto: {fmtDate(s.lastOkAt)}{#if s.failCount > 0}
                · Fallos: {s.failCount}{s.lastError ? ` (${s.lastError})` : ''}{/if}
            </p>
          </div>
          <button
            type="button"
            class="btn btn-quiet"
            disabled={busy}
            aria-label={`Quitar ${s.label}`}
            onclick={() => remove(s)}>Quitar</button
          >
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  h2 {
    font-size: var(--fs-l);
    margin: 0 0 var(--sp-2) var(--sp-1);
  }
  .help,
  .msg {
    margin: 0 var(--sp-1) var(--sp-3);
    font-size: var(--fs-s);
    color: var(--ink-2);
  }
  .err {
    color: var(--danger);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    margin-bottom: var(--sp-3);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-3);
    min-height: var(--tap);
    padding: var(--sp-2) var(--sp-4);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .grow p {
    margin: 0;
  }
  .small {
    font-size: var(--fs-s);
  }
</style>
