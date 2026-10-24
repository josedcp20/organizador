<script lang="ts">
  import { onMount } from 'svelte';
  import ExpiryPicker from '../components/ExpiryPicker.svelte';
  import Banner from '../components/Banner.svelte';
  import { navigateTo } from '../router';
  import {
    NOTE_MAX_CHARS,
    createQuickNote,
    daysValid,
    quickDraft,
    noteErrorMessage,
    toExpiryInput,
    type ExpiryMode,
  } from '../lib/notes';

  let title = 'Nota Rápida';
  let noteText = $state(quickDraft.text);
  let mode = $state<ExpiryMode>('today');
  let days = $state(7);
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
    saving = true;
    try {
      const expiry = toExpiryInput(mode, days);
      await createQuickNote({ body: text, ...(expiry ? { expiry } : {}) });
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

<div class="container">
  <h1>{title}</h1>
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
  <div class="actions">
    <button class="save" onclick={handleSave} disabled={saving || saved}>
      {saving ? 'Guardando...' : 'Guardar'}
    </button>
    <button onclick={handleCancel} class="secondary">Cancelar</button>
  </div>
</div>

<style>
  .container {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  h1 {
    margin: 0;
  }

  textarea {
    flex: 1;
    min-height: 160px;
    padding: 0.5rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-family: inherit;
    font-size: 1rem;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  button {
    padding: 0.75rem 1.5rem;
    min-height: 48px;
    background-color: #4285f4;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 1rem;
  }

  button.save {
    flex: 1;
    min-height: 56px;
    font-size: 1.15rem;
    font-weight: 600;
  }

  button:disabled {
    opacity: 0.6;
  }

  button:hover:not(:disabled) {
    background-color: #357ae8;
  }

  button.secondary {
    background-color: #999;
  }

  button.secondary:hover {
    background-color: #666;
  }
</style>
