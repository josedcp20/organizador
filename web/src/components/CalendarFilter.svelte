<script lang="ts">
  import {
    filterCalendars,
    hiddenCalendars,
    showApp,
    toggleApp,
    toggleCalendar,
  } from '../lib/calendarFilter';

  // chips: fila desplazable bajo la cabecera (movil). list: interruptores en el menu lateral.
  let { variant = 'chips' }: { variant?: 'chips' | 'list' } = $props();

  const APP_COLOR = 'var(--ink-2)';
</script>

{#snippet items()}
  {#each $filterCalendars as cal (cal.id)}
    {@render item(cal.name, cal.color, !$hiddenCalendars.has(cal.id), () => toggleCalendar(cal.id))}
  {/each}
  {@render item('Creados en la app', APP_COLOR, $showApp, toggleApp)}
{/snippet}

{#snippet item(name: string, color: string, on: boolean, toggle: () => void)}
  {#if variant === 'list'}
    <button
      type="button"
      class="row"
      role="switch"
      aria-checked={on}
      style:--c={color}
      onclick={toggle}
    >
      <span class="dot" class:off={!on} aria-hidden="true"></span>
      <span class="name">{name}</span>
      <span class="track" class:on aria-hidden="true"><span class="knob"></span></span>
    </button>
  {:else}
    <button
      type="button"
      class="chip"
      class:off={!on}
      style:--c={color}
      aria-pressed={on}
      onclick={toggle}
    >
      <span class="dot" class:off={!on} aria-hidden="true"></span>{name}
    </button>
  {/if}
{/snippet}

{#if variant === 'list'}
  <div class="side" role="group" aria-label="Filtro de calendarios">
    <p class="side-title">Calendarios</p>
    {@render items()}
  </div>
{:else}
  <div class="chips" role="group" aria-label="Filtro de calendarios">
    {@render items()}
  </div>
{/if}

<style>
  .dot {
    flex: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--c);
    border: 1.5px solid var(--c);
  }
  .dot.off {
    background: transparent;
  }

  /* Movil: chips en una fila desplazable */
  .chips {
    display: flex;
    gap: var(--sp-2);
    margin: 0 calc(-1 * var(--sp-4)) var(--sp-4);
    padding: 2px var(--sp-4);
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .chips::-webkit-scrollbar {
    display: none;
  }
  .chip {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--sp-2);
    min-height: var(--tap);
    padding: 0 var(--sp-4);
    border: 1.5px solid var(--ink-2);
    border-radius: 999px;
    background: var(--surface);
    color: var(--ink);
    font-weight: 600;
    white-space: nowrap;
  }
  .chip.off {
    border: 1.5px dashed var(--line);
    background: transparent;
    color: var(--ink-2);
    font-weight: 500;
  }
  @media (min-width: 1024px) {
    .chips {
      display: none;
    }
  }

  /* Escritorio: lista con interruptores en el menu lateral */
  .side {
    display: grid;
    gap: 2px;
    padding-top: var(--sp-4);
    border-top: 1px solid var(--line);
  }
  .side-title {
    padding: 0 var(--sp-3) var(--sp-1);
    color: var(--ink-2);
    font-size: var(--fs-s);
    font-weight: 600;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    min-height: var(--tap);
    padding: 0 var(--sp-3);
    border: 0;
    border-radius: var(--r-s);
    background: none;
    color: var(--ink);
    text-align: left;
  }
  .row:hover {
    background: var(--surface-2);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    line-height: 1.25;
  }
  .track {
    flex: none;
    display: flex;
    align-items: center;
    width: 36px;
    height: 22px;
    padding: 2px;
    border: 1.5px solid var(--ink-2);
    border-radius: 999px;
    background: var(--surface-2);
  }
  .track.on {
    background: var(--c);
    justify-content: flex-end;
  }
  .knob {
    width: 15px;
    height: 15px;
    border: 1.5px solid var(--ink-2);
    border-radius: 50%;
    background: var(--surface);
  }
</style>
