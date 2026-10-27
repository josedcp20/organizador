<script lang="ts">
  import { onMount } from 'svelte';
  import AlarmPicker from '../components/AlarmPicker.svelte';
  import ExpiryPicker from '../components/ExpiryPicker.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Banner from '../components/Banner.svelte';
  import { navigateTo } from '../router';
  import {
    NOTE_MAX_CHARS,
    createQuickNote,
    daysValid,
    quickDraft,
    noteErrorMessage,
    toExpiryInput,
    validateAlarm,
    type ExpiryMode,
  } from '../lib/notes';

  let noteText = $state(quickDraft.text);
  let mode = $state<ExpiryMode>('today');
  let days = $state(7);
  let remindAt = $state('');
  let saving = $state(false);
  let saved = $state(false);
  let error = $state('');
  let area = $state<HTMLTextAreaElement | undefined>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function handleSave() {
    if (saving || saved) return;
    error = '';
    const text = noteText.trim();
    if (!text) {
      error = 'Escribe algo antes de guardar.';
      return;
    }
    if (text.length > NOTE_MAX_CHARS) {
      error = `La nota es demasiado larga (máximo ${NOTE_MAX_CHARS} caracteres).`;
      return;
    }
    if (mode === 'days' && !daysValid(days)) {
      error = 'Los días deben ser un número entero entre 1 y 365.';
      return;
    }
    const alarmError = remindAt ? validateAlarm(remindAt) : '';
    if (alarmError) {
      error = alarmError;
      return;
    }
    saving = true;
    try {
      const expiry = toExpiryInput(mode, days);
      await createQuickNote({
        body: text,
        ...(expiry ? { expiry } : {}),
        ...(remindAt ? { remind_at: remindAt } : {}),
      });
      saved = true;
      noteText = '';
      quickDraft.text = '';
      timer = setTimeout(() => navigateTo('hoy'), 700);
    } catch (e) {
      // El texto se conserva para poder reintentar.
      error = noteErrorMessage(e) || 'No se pudo guardar. Inténtalo de nuevo.';
    } finally {
      saving = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSave();
    }
  }

  function handleCancel() {
    navigateTo('hoy');
  }

  onMount(() => {
    area?.focus();
    return () => clearTimeout(timer);
  });
</script>

<div class="quick">
  <PageHeader title="Nota Rápida" />
  {#if saved}<Banner kind="info">Nota guardada</Banner>{/if}
  {#if error}<Banner kind="error">{error}</Banner>{/if}
  <textarea
    aria-label="Texto de la nota"
    placeholder="Escribe tu nota..."
    bind:value={noteText}
    bind:this={area}
    oninput={() => (quickDraft.text = noteText)}
    onkeydown={onKeydown}
  ></textarea>
  <ExpiryPicker bind:mode bind:days idPrefix="nr" />
  <AlarmPicker bind:value={remindAt} idPrefix="nr" />
  <div class="actions">
    <button class="btn btn-primary save" onclick={handleSave} disabled={saving || saved}>
      {saving ? 'Guardando...' : 'Guardar'}
    </button>
    <button class="btn btn-quiet" onclick={handleCancel}>Cancelar</button>
  </div>
</div>

<style>
  .quick {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    max-width: 40rem;
  }

  textarea {
    min-height: 40dvh;
    padding: var(--sp-4);
    border-radius: var(--r-m);
    font-size: var(--fs-l);
  }

  .actions {
    display: flex;
    gap: var(--sp-2);
  }

  .save {
    flex: 1;
    min-height: 56px;
    font-size: var(--fs-l);
  }
</style>
