<script lang="ts">
  import type { Snippet } from 'svelte';

  // Titulo grande de pagina (estilo iOS) + acciones opcionales a la derecha.
  let { title, actions }: { title: string; actions?: Snippet } = $props();
</script>

<header class="page-head">
  <h1>{title}</h1>
  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</header>

<style>
  .page-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--sp-3) var(--sp-4);
    margin-bottom: var(--sp-5);
  }

  h1 {
    font-size: var(--fs-2xl);
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
</style>
