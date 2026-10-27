<script lang="ts">
  let {
    done,
    busy = false,
    title,
    onToggle,
  }: { done: boolean; busy?: boolean; title: string; onToggle: () => void } = $props();
</script>

<!-- Hermano del enlace (nunca dentro): tocarlo no navega. 44 px de objetivo tactil. -->
<button
  type="button"
  class="done-toggle"
  class:on={done}
  aria-pressed={done}
  aria-label={`Hecho: ${title}`}
  disabled={busy}
  onclick={onToggle}
>
  <span class="box" aria-hidden="true">
    {#if done}
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
    {/if}
  </span>
</button>

<style>
  .done-toggle {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    min-width: var(--tap);
    min-height: var(--tap);
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink);
  }
  .box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 2px solid var(--ink-2);
    border-radius: var(--r-s);
  }
  /* Rotulador: relleno amarillo con tinta oscura */
  .on .box {
    border-color: var(--mark-ink);
    background: var(--mark);
    color: var(--mark-ink);
  }
  .done-toggle:disabled {
    opacity: 0.6;
  }
</style>
