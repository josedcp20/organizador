<script lang="ts">
  import type { ExpiryMode } from '../lib/notes';

  let {
    mode = $bindable('forever'),
    days = $bindable(7),
    allowKeep = false,
    idPrefix = 'exp',
  }: { mode?: ExpiryMode; days?: number; allowKeep?: boolean; idPrefix?: string } = $props();
</script>

<div class="expiry">
  <label for={`${idPrefix}-mode`}>Caducidad</label>
  <select id={`${idPrefix}-mode`} bind:value={mode}>
    {#if allowKeep}<option value="keep">Mantener la actual</option>{/if}
    <option value="forever">Sin caducidad</option>
    <option value="today">Solo hoy</option>
    <option value="days">Número de días</option>
  </select>
  {#if mode === 'days'}
    <span class="days">
      <input type="number" min="1" max="365" step="1" bind:value={days} aria-label="Días" />
      <span aria-hidden="true">días</span>
    </span>
  {/if}
</div>

<style>
  .expiry {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  select,
  input {
    min-height: 44px;
    padding: 0.4rem 0.5rem;
    font-size: 1rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-family: inherit;
  }

  input {
    width: 5rem;
  }

  .days {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
</style>
