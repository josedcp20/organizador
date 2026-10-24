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
    gap: var(--sp-2);
  }

  .expiry label {
    flex-basis: 100%;
    font-size: var(--fs-s);
  }

  select {
    flex: 1;
    min-width: 12rem;
  }

  .days {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  .days input {
    width: 5.5rem;
  }

  /* iOS: etiqueta a la izquierda, control a la derecha */
  @media (hover: none) and (pointer: coarse) {
    .expiry {
      flex-wrap: nowrap;
      justify-content: space-between;
    }
    .expiry label {
      flex: 1 1 auto;
      min-width: 0;
    }
    select {
      flex: 0 1 auto;
      min-width: 0;
      max-width: 60%;
    }
    .days {
      flex: none;
    }
    .days input {
      width: 4.5rem;
      text-align: right;
    }
  }
</style>
