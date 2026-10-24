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
    <span class="expiry">{label}</span>
  </p>
  {#if confirming}
    <div class="confirm" role="alertdialog" aria-label="Confirmar borrado">
      <span>¿Borrar esta nota?</span>
      <button type="button" class="danger" disabled={busy} onclick={ondelete}>Confirmar borrado</button>
      <button type="button" class="secondary" bind:this={cancelBtn} onclick={cancelConfirm}>
        Cancelar
      </button>
    </div>
  {:else}
    <div class="actions">
      <button type="button" class="secondary" disabled={busy} onclick={onedit}>Editar</button>
      <button type="button" class="secondary" disabled={busy} onclick={onpin}>
        {note.pinned ? 'Desfijar' : 'Fijar'}
      </button>
      <button
        type="button"
        class="secondary"
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
    padding: 0.6rem 0.75rem;
    margin-bottom: 0.5rem;
    background: #f7f7f7;
    border-left: 5px solid #bbb;
    border-radius: 4px;
  }

  .note.pinned {
    border-left-color: #f9ab00;
  }

  h3 {
    margin: 0 0 0.25rem;
    font-size: 1rem;
  }

  .body {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .meta {
    margin: 0.4rem 0;
    font-size: 0.8rem;
    color: #666;
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .badge {
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: #fde8b0;
    color: #5b3b00;
  }

  .actions,
  .confirm {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
  }

  button {
    padding: 0.4rem 0.8rem;
    min-height: 44px;
    border: none;
    border-radius: 4px;
    color: #fff;
    background: #1a73e8;
  }

  button.secondary {
    background: #777;
  }

  button.danger {
    background: #c5221f;
  }

  button:disabled {
    opacity: 0.6;
  }
</style>
