<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    kind = 'info',
    children,
  }: { kind?: 'info' | 'warning' | 'error'; children?: Snippet } = $props();
</script>

<div class={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
  {@render children?.()}
</div>

<style>
  /* Texto en --ink (AA garantizado); el estado lo da la barra y el tinte. */
  .banner {
    --tone: var(--accent);
    margin: 0 0 var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-left: 4px solid var(--tone);
    border-radius: var(--r-s);
    background: color-mix(in srgb, var(--tone) 12%, var(--surface));
    color: var(--ink);
    font-size: var(--fs-s);
  }

  .warning {
    --tone: var(--warn);
  }

  .error {
    --tone: var(--danger);
  }

  .banner :global(a) {
    color: inherit;
    font-weight: 600;
  }
</style>
