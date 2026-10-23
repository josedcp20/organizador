<script lang="ts">
  import type { CalendarInfo } from '@organizador/shared';

  let {
    calendars,
    hidden,
    showApp,
    appColor = '#546e7a',
    onToggleCalendar,
    onToggleApp,
  }: {
    calendars: CalendarInfo[];
    hidden: ReadonlySet<string>;
    showApp: boolean;
    appColor?: string;
    onToggleCalendar: (id: string) => void;
    onToggleApp: () => void;
  } = $props();
</script>

<div class="filter" role="group" aria-label="Filtro de calendarios">
  {#each calendars as cal (cal.id)}
    <button
      type="button"
      class="fchip"
      class:off={hidden.has(cal.id)}
      style:--c={cal.color}
      aria-pressed={!hidden.has(cal.id)}
      onclick={() => onToggleCalendar(cal.id)}
    >
      <span class="swatch" aria-hidden="true"></span>{cal.name}
    </button>
  {/each}
  <button
    type="button"
    class="fchip"
    class:off={!showApp}
    style:--c={appColor}
    aria-pressed={showApp}
    onclick={onToggleApp}
  >
    <span class="swatch" aria-hidden="true"></span>★ Creados en la app
  </button>
</div>

<style>
  .filter {
    display: flex;
    gap: 0.5rem;
    overflow-x: auto;
    padding: 0.25rem 0 0.5rem;
    -webkit-overflow-scrolling: touch;
  }
  .fchip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
    min-height: 40px;
    padding: 0 0.8rem;
    border-radius: 20px;
    border: 1.5px solid var(--c);
    background: #fff;
    color: #222;
    font-size: 0.95rem;
  }
  .swatch {
    width: 0.8rem;
    height: 0.8rem;
    border-radius: 50%;
    background: var(--c);
  }
  .fchip.off {
    opacity: 0.5;
    border-style: dashed;
  }
  .fchip.off .swatch {
    background: transparent;
    border: 1.5px solid var(--c);
  }
</style>
