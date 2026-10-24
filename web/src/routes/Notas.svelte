<script lang="ts">
  import { onMount } from 'svelte';
  import { isExpired, type NoteInfo } from '@organizador/shared';
  import Banner from '../components/Banner.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import NoteForm, { type NoteFormValues } from '../components/NoteForm.svelte';
  import NoteItem from '../components/NoteItem.svelte';
  import { ApiError } from '../lib/api';
  import {
    createNote,
    deleteNote,
    fetchNotes,
    loadNotesCache,
    noteErrorMessage,
    patchNote,
    saveNotesCache,
    sortNotes,
    toExpiryInput,
  } from '../lib/notes';

  let notes = $state<NoteInfo[]>([]);
  let loading = $state(true);
  let error = $state('');
  let offline = $state(false);
  let savedAt = $state('');
  let filter = $state<'note' | 'quick'>('note');
  let creating = $state(false);
  let editingId = $state<string | null>(null);
  let busy = $state(false);
  let formError = $state('');
  let actionError = $state('');
  let seq = 0;
  let alive = true;
  let now = $state(Date.now());

  // Las caducadas no se muestran aunque sigan en memoria o en la cache.
  const live = $derived(notes.filter((n) => !isExpired(n.expiresAt, now)));
  const visible = $derived(sortNotes(live.filter((n) => n.kind === filter)));
  const quickCount = $derived(live.filter((n) => n.kind === 'quick').length);
  const noteCount = $derived(live.filter((n) => n.kind === 'note').length);

  function setNotes(list: NoteInfo[]) {
    notes = list;
    saveNotesCache(list);
  }

  /** Inicia una accion: descarta un GET en vuelo y devuelve su token. */
  function begin(): number {
    const mine = ++seq;
    loading = false;
    busy = true;
    return mine;
  }

  async function load() {
    const mine = ++seq;
    loading = true;
    error = '';
    try {
      const res = await fetchNotes();
      if (mine !== seq || !alive) return;
      notes = res.notes;
      offline = false;
      saveNotesCache(res.notes);
    } catch (e) {
      if (mine !== seq || !alive) return;
      if (e instanceof ApiError && e.status === 401) return;
      const cache = e instanceof ApiError && e.code === 'network' ? loadNotesCache() : null;
      if (cache) {
        notes = cache.notes.filter((n) => !isExpired(n.expiresAt, Date.now()));
        offline = true;
        savedAt = cache.savedAt;
      } else {
        error = `No se pudieron cargar las notas. ${noteErrorMessage(e)}`;
      }
    } finally {
      if (mine === seq && alive) loading = false;
    }
  }

  function dropNote(id: string) {
    if (editingId === id) editingId = null;
    setNotes(notes.filter((x) => x.id !== id));
  }

  async function submitCreate(v: NoteFormValues) {
    begin();
    formError = '';
    try {
      const expiry = toExpiryInput(v.mode, v.days);
      const created = await createNote({
        body: v.body,
        title: v.title.trim() || null,
        pinned: v.pinned,
        ...(expiry ? { expiry } : {}),
      });
      if (!alive) return;
      setNotes([created, ...notes.filter((n) => n.id !== created.id)]);
      filter = 'note';
      creating = false;
    } catch (e) {
      if (alive) formError = noteErrorMessage(e);
    } finally {
      if (alive) busy = false;
    }
  }

  async function submitEdit(id: string, v: NoteFormValues) {
    begin();
    formError = '';
    try {
      const expiry = toExpiryInput(v.mode, v.days);
      const updated = await patchNote(id, {
        body: v.body,
        title: v.title.trim() || null,
        pinned: v.pinned,
        ...(expiry ? { expiry } : {}),
      });
      if (!alive) return;
      setNotes(notes.map((n) => (n.id === id ? updated : n)));
      editingId = null;
    } catch (e) {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 404) {
        dropNote(id);
        actionError = noteErrorMessage(e);
      } else {
        formError = noteErrorMessage(e);
      }
    } finally {
      if (alive) busy = false;
    }
  }

  async function togglePin(n: NoteInfo) {
    begin();
    actionError = '';
    try {
      const updated = await patchNote(n.id, { pinned: !n.pinned });
      if (!alive) return;
      setNotes(notes.map((x) => (x.id === n.id ? updated : x)));
    } catch (e) {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 404) dropNote(n.id);
      actionError = noteErrorMessage(e);
    } finally {
      if (alive) busy = false;
    }
  }

  async function remove(n: NoteInfo) {
    begin();
    actionError = '';
    try {
      await deleteNote(n.id);
      if (alive) dropNote(n.id);
    } catch (e) {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 404) {
        dropNote(n.id);
      } else {
        actionError = noteErrorMessage(e);
      }
    } finally {
      if (alive) busy = false;
    }
  }

  function startCreate() {
    formError = '';
    editingId = null;
    creating = true;
  }

  function startEdit(id: string) {
    formError = '';
    creating = false;
    editingId = id;
  }

  onMount(() => {
    alive = true;
    void load();
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => {
      alive = false;
      seq++;
      clearInterval(timer);
    };
  });
</script>

<PageHeader title="Notas">
  {#snippet actions()}
    <button type="button" class="btn btn-quiet" disabled={loading || busy} onclick={() => load()}>
      {loading ? 'Actualizando...' : 'Actualizar'}
    </button>
    <button type="button" class="btn btn-primary" disabled={creating} onclick={startCreate}
      >Nueva nota</button
    >
  {/snippet}
</PageHeader>

{#if offline}
  <Banner kind="warning">
    Sin conexión, datos guardados{savedAt
      ? ` (${new Date(savedAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })})`
      : ''}.
  </Banner>
{/if}
{#if error}<Banner kind="error">{error}</Banner>{/if}
{#if actionError}<Banner kind="error">{actionError}</Banner>{/if}

{#if creating}
  <NoteForm {busy} error={formError} onsubmit={submitCreate} oncancel={() => (creating = false)} />
{/if}

<div class="seg" role="group" aria-label="Tipo de nota">
  <button
    type="button"
    class:on={filter === 'note'}
    aria-pressed={filter === 'note'}
    onclick={() => (filter = 'note')}>Notas ({noteCount})</button
  >
  <button
    type="button"
    class:on={filter === 'quick'}
    aria-pressed={filter === 'quick'}
    onclick={() => (filter = 'quick')}>Rápidas ({quickCount})</button
  >
</div>

{#if loading && notes.length === 0}
  <p role="status" class="muted">Cargando...</p>
{:else if !error && visible.length === 0}
  <p class="muted empty">
    {filter === 'note' ? 'No hay notas todavía.' : 'No hay notas rápidas vigentes.'}
  </p>
{/if}

<ul class="list notes">
  {#each visible as n (n.id)}
    {#if editingId === n.id}
      <li class="editing">
        <NoteForm
          note={n}
          {busy}
          error={formError}
          onsubmit={(v) => submitEdit(n.id, v)}
          oncancel={() => (editingId = null)}
        />
      </li>
    {:else}
      <NoteItem
        note={n}
        {busy}
        onedit={() => startEdit(n.id)}
        onpin={() => togglePin(n)}
        ondelete={() => remove(n)}
      />
    {/if}
  {/each}
</ul>

<style>
  .seg {
    display: inline-flex;
    gap: 2px;
    margin-bottom: var(--sp-4);
    padding: 2px;
    border-radius: var(--r-m);
    background: var(--line);
  }

  .seg button {
    min-height: var(--tap);
    padding: 0 var(--sp-4);
    border: 0;
    border-radius: calc(var(--r-m) - 2px);
    background: transparent;
    color: var(--ink-2);
    font-weight: 600;
  }

  .seg button.on {
    background: var(--surface);
    color: var(--ink);
  }

  .empty {
    padding: var(--sp-4);
    border-radius: var(--r-m);
    background: var(--surface);
  }

  .editing {
    padding: var(--sp-3);
  }

  /* Escritorio: rejilla de notas en vez de una columna estirada */
  @media (min-width: 1024px) {
    .notes {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
      gap: var(--sp-3);
      background: transparent;
      overflow: visible;
    }

    .notes > :global(li) {
      border-top: 0 !important;
      border-radius: var(--r-m);
      background: var(--surface);
    }
  }
</style>
