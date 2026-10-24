<script lang="ts" module>
  import type { ExpiryMode } from '../lib/notes';

  export interface NoteFormValues {
    title: string;
    body: string;
    pinned: boolean;
    mode: ExpiryMode;
    days: number;
  }
</script>

<script lang="ts">
  import type { NoteInfo } from '@organizador/shared';
  import ExpiryPicker from './ExpiryPicker.svelte';
  import { NOTE_MAX_CHARS, daysValid } from '../lib/notes';

  let {
    note = null,
    busy = false,
    error = '',
    onsubmit,
    oncancel,
  }: {
    note?: NoteInfo | null;
    busy?: boolean;
    error?: string;
    onsubmit: (v: NoteFormValues) => void;
    oncancel: () => void;
  } = $props();

  // Valores iniciales: se capturan una vez (el formulario se desmonta al terminar).
  // svelte-ignore state_referenced_locally
  let title = $state(note?.title ?? '');
  // svelte-ignore state_referenced_locally
  let body = $state(note?.body ?? '');
  // svelte-ignore state_referenced_locally
  let pinned = $state(note?.pinned ?? false);
  // svelte-ignore state_referenced_locally
  let mode = $state<ExpiryMode>(note ? 'keep' : 'forever');
  let days = $state(7);
  let localError = $state('');

  function submit(e: Event) {
    e.preventDefault();
    localError = '';
    if (body.trim().length < 1) {
      localError = 'Escribe el texto de la nota.';
      return;
    }
    if (body.trim().length > NOTE_MAX_CHARS) {
      localError = `La nota es demasiado larga (máximo ${NOTE_MAX_CHARS} caracteres).`;
      return;
    }
    if (mode === 'days' && !daysValid(days)) {
      localError = 'Los días deben ser un número entero entre 1 y 365.';
      return;
    }
    onsubmit({ title, body, pinned, mode, days });
  }
</script>

<form class="note-form" onsubmit={submit}>
  <label>
    Título (opcional)
    <input type="text" maxlength="200" bind:value={title} />
  </label>
  <label>
    Nota
    <textarea rows="5" bind:value={body}></textarea>
  </label>
  <label class="check">
    <input type="checkbox" bind:checked={pinned} /> Fijar arriba
  </label>
  <ExpiryPicker bind:mode bind:days allowKeep={note !== null} idPrefix="nf" />
  {#if localError || error}
    <p class="err" role="alert">{localError || error}</p>
  {/if}
  <div class="actions">
    <button type="submit" disabled={busy}>{busy ? 'Guardando...' : 'Guardar'}</button>
    <button type="button" class="secondary" disabled={busy} onclick={oncancel}>Cancelar</button>
  </div>
</form>

<style>
  .note-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    margin-bottom: 1rem;
    background: #f7f7f7;
    border-radius: 6px;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.9rem;
  }

  label.check {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }

  input[type='text'],
  textarea {
    padding: 0.5rem;
    font-size: 1rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-family: inherit;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  button {
    padding: 0.5rem 1rem;
    min-height: 44px;
    background: #1a73e8;
    color: #fff;
    border: none;
    border-radius: 4px;
    font-size: 1rem;
  }

  button.secondary {
    background: #777;
  }

  button:disabled {
    opacity: 0.6;
  }

  .err {
    margin: 0;
    color: #8a1c13;
  }
</style>
