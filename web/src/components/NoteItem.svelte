<script lang="ts">
  import { tick } from 'svelte';
  import type { NoteInfo } from '@organizador/shared';
  import { expiryLabel } from '../lib/notes';

  let {
    note,
    busy = false,
    onedit,
    onpin,
    ondelete,
  }: {
    note: NoteInfo;
    busy?: boolean;
    onedit: () => void;
    onpin: () => void;
    ondelete: () => void;
  } = $props();

  let confirming = $state(false);
  let cancelBtn = $state<HTMLButtonElement | undefined>();
  let deleteBtn = $state<HTMLButtonElement | undefined>();

  async function askConfirm() {
    confirming = true;
    await tick();
    cancelBtn?.focus();
  }

  async function cancelConfirm() {
    confirming = false;
    await tick();
    deleteBtn?.focus();
  }
  const label = $derived(expiryLabel(note.expiresAt));
</script>

<li class="note" class:pinned={note.pinned}>
  {#if note.title}<h3>{note.title}</h3>{/if}
  <p class="body">{note.body}</p>
  <p class="meta">
    {#if note.pinned}<span class="badge">Fijada</span>{/if}
    <span class="expiry" class:warn={label.startsWith('caduca hoy')}>{label}</span>
  </p>
  {#if confirming}
    <div class="confirm" role="alertdialog" aria-label="Confirmar borrado">
      <span>¿Borrar esta nota?</span>
      <button type="button" class="btn btn-danger" disabled={busy} onclick={ondelete}>Confirmar borrado</button>
      <button type="button" class="btn btn-quiet" bind:this={cancelBtn} onclick={cancelConfirm}>
        Cancelar
      </button>
    </div>
  {:else}
    <div class="actions">
      <button type="button" class="btn btn-quiet" disabled={busy} onclick={onedit}>Editar</button>
      <button type="button" class="btn btn-quiet" disabled={busy} onclick={onpin}>
        {note.pinned ? 'Desfijar' : 'Fijar'}
      </button>
      <button
        type="button"
        class="btn btn-quiet"
        bind:this={deleteBtn}
        disabled={busy}
        onclick={askConfirm}
      >
        Borrar
      </button>
    </div>
  {/if}
</li>

<style>
  .note {
    list-style: none;
    display: grid;
    gap: var(--sp-1);
    padding: var(--sp-3) var(--sp-4);
    border-left: 3px solid transparent;
  }

  .note.pinned {
    border-left-color: var(--ink-2);
  }

  h3 {
    font-size: var(--fs-m);
  }

  .body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .meta {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
    color: var(--ink-2);
    font-size: var(--fs-s);
  }

  .badge {
    padding: 0 var(--sp-2);
    border-radius: var(--r-s);
    background: var(--surface-2);
    font-weight: 600;
  }

  .warn {
    color: var(--warn);
    font-weight: 600;
  }

  .actions,
  .confirm {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
    align-items: center;
    margin: 0 calc(-1 * var(--sp-2));
  }
</style>
