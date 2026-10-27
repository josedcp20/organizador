<script lang="ts" module>
  import type { ExpiryMode } from '../lib/notes';

  export interface NoteFormValues {
    title: string;
    body: string;
    pinned: boolean;
    mode: ExpiryMode;
    days: number;
    /** Solo notas rapidas: undefined = sin cambios, null = quitar, string = nueva alarma. */
    remindAt?: string | null;
  }
</script>

<script lang="ts">
  import type { NoteInfo } from '@organizador/shared';
  import AlarmPicker from './AlarmPicker.svelte';
  import ExpiryPicker from './ExpiryPicker.svelte';
  import { NOTE_MAX_CHARS, daysValid, toMadridLocalInput, validateAlarm } from '../lib/notes';

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
  // svelte-ignore state_referenced_locally
  const initialAlarm = note?.remindAt ? toMadridLocalInput(note.remindAt) : '';
  let remindAt = $state(initialAlarm);
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
    const alarmError = remindAt && remindAt !== initialAlarm ? validateAlarm(remindAt) : '';
    if (alarmError) {
      localError = alarmError;
      return;
    }
    const v: NoteFormValues = { title, body, pinned, mode, days };
    if (note?.kind === 'quick' && remindAt !== initialAlarm) v.remindAt = remindAt || null;
    onsubmit(v);
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
  {#if note?.kind === 'quick'}<AlarmPicker bind:value={remindAt} idPrefix="nf" />{/if}
  {#if localError || error}
    <p class="err" role="alert">{localError || error}</p>
  {/if}
  <div class="actions">
    <button type="submit" class="btn btn-primary" disabled={busy}>{busy ? 'Guardando...' : 'Guardar'}</button>
    <button type="button" class="btn" disabled={busy} onclick={oncancel}>Cancelar</button>
  </div>
</form>

<style>
  .note-form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-4);
    margin-bottom: var(--sp-4);
    border-radius: var(--r-m);
    background: var(--surface);
  }

  label {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    font-size: var(--fs-s);
  }

  label.check {
    flex-direction: row;
    align-items: center;
    gap: var(--sp-2);
    min-height: var(--tap);
    font-size: var(--fs-m);
  }

  .actions {
    display: flex;
    gap: var(--sp-2);
  }

  .err {
    color: var(--danger);
  }
</style>
