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
  .banner {
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    margin: 0 0 0.75rem 0;
    border-left: 4px solid currentColor;
  }

  .info {
    background: #e8f0fe;
    color: #174ea6;
  }

  .warning {
    background: #fef7e0;
    color: #7a4b00;
  }

  .error {
    background: #fdecea;
    color: #8a1c13;
  }
</style>
