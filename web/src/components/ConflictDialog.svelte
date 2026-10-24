<script lang="ts">
  import type { EventInfo } from '@organizador/shared';
  import { formatWhen } from '../lib/eventDetail';

  // 409 `conflict`: el evento cambio en Google. Presentacional; el padre decide que hacer.
  let {
    open,
    mode,
    current,
    onUseServer,
    onOverwrite,
    onCancel,
  }: {
    open: boolean;
    mode: 'edit' | 'delete';
    current: EventInfo | null;
    onUseServer: () => void;
    onOverwrite: () => void;
    onCancel: () => void;
  } = $props();

  let dlg: HTMLDialogElement;

  $effect(() => {
    if (open && !dlg.open) dlg.showModal();
    else if (!open && dlg.open) dlg.close();
  });
</script>

<dialog
  class="sheet"
  bind:this={dlg}
  aria-labelledby="cd-title"
  aria-describedby="cd-text"
  oncancel={(e) => {
    e.preventDefault();
    onCancel();
  }}
>
  {#if current}
    <h2 id="cd-title">El evento cambió en Google</h2>
    <div id="cd-text">
      <p class="muted">Versión actual de Google:</p>
      <p class="server">
        <strong>{current.summary}</strong><br />
        {formatWhen(current)}
        {#if current.location}<br />{current.location}{/if}
      </p>
      <p class="muted">
        {mode === 'edit'
          ? 'Si usas la versión de Google, tus cambios se pierden. Si sobrescribes, se aplican tus cambios.'
          : 'Puedes borrarlo de todas formas o ver primero la versión de Google.'}
      </p>
    </div>
    <div class="row">
      <button type="button" class="btn" onclick={onCancel}>Cancelar</button>
      <button type="button" class="btn" onclick={onUseServer}>
        {mode === 'edit' ? 'Usar la versión de Google' : 'Ver la versión de Google'}
      </button>
      <button
        type="button"
        class="btn"
        class:btn-danger={mode === 'delete'}
        class:btn-primary={mode === 'edit'}
        onclick={onOverwrite}
      >
        {mode === 'edit' ? 'Sobrescribir con mis cambios' : 'Borrar de todas formas'}
      </button>
    </div>
  {:else}
    <h2 id="cd-title">El evento ya no existe</h2>
    <p id="cd-text" class="muted">El evento ya no existe en Google.</p>
    <div class="row">
      <button type="button" class="btn btn-primary" onclick={onCancel}>Cerrar</button>
    </div>
  {/if}
</dialog>

<style>
  h2 {
    margin-bottom: var(--sp-2);
    font-size: var(--fs-l);
  }
  p {
    margin-bottom: var(--sp-3);
  }
  .server {
    padding: var(--sp-3);
    border-radius: var(--r-s);
    background: var(--surface-2);
    overflow-wrap: anywhere;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--sp-2);
  }
</style>
