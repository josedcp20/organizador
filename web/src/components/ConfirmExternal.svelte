<script lang="ts">
  // Confirmacion para tocar un evento de Google no creado por la app. Presentacional.
  let {
    open,
    action,
    summary,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    action: 'edit' | 'delete';
    summary: string;
    onConfirm: () => void;
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
  aria-labelledby="ce-title"
  aria-describedby="ce-text"
  oncancel={(e) => {
    e.preventDefault();
    onCancel();
  }}
>
  <h2 id="ce-title">{summary}</h2>
  <p id="ce-text">
    Este evento no lo creaste en la app;
    {action === 'delete'
      ? 'se borrará también de Google Calendar.'
      : 'el cambio se aplicará en Google Calendar.'}
  </p>
  <div class="row">
    <button type="button" class="btn" onclick={onCancel}>Cancelar</button>
    <button
      type="button"
      class="btn"
      class:btn-danger={action === 'delete'}
      class:btn-primary={action !== 'delete'}
      onclick={onConfirm}
    >
      {action === 'delete' ? 'Borrar en Google' : 'Aplicar en Google'}
    </button>
  </div>
</dialog>

<style>
  h2 {
    margin-bottom: var(--sp-2);
    font-size: var(--fs-l);
    overflow-wrap: anywhere;
  }
  p {
    margin-bottom: var(--sp-4);
    color: var(--ink-2);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--sp-2);
  }
</style>
