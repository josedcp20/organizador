<script lang="ts">
  import { addDaysToDateStr } from '@organizador/shared';
  import type { CalEvent } from '../lib/events';
  import { formatDayLong } from '../lib/events';
  import EventChip from './EventChip.svelte';

  let {
    from,
    month,
    byDay,
    today,
    onPickDay,
  }: {
    from: string;
    /** YYYY-MM del mes mostrado. */
    month: string;
    byDay: Map<string, CalEvent[]>;
    today: string;
    onPickDay: (day: string) => void;
  } = $props();

  const MAX = 3;
  const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const WEEKDAYS_LONG = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
  const WEEKDAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const eventsLabel = (n: number) =>
    n === 0 ? 'sin eventos' : n === 1 ? '1 evento' : `${n} eventos`;
  const days = $derived(Array.from({ length: 42 }, (_, i) => addDaysToDateStr(from, i)));
</script>

<div class="grid" role="group" aria-label="Mes">
  {#each WEEKDAYS as w, i (w)}
    <div class="wd" aria-hidden="true" title={WEEKDAY_NAMES[i]}>
      <span class="w-s">{w}</span><span class="w-l">{WEEKDAYS_LONG[i]}</span>
    </div>
  {/each}
  {#each days as day, i (day)}
    {@const evs = byDay.get(day) ?? []}
    <div
      class="cell"
      class:other={!day.startsWith(month)}
      class:weekend={i % 7 > 4}
      class:today={day === today}
    >
      <button
        type="button"
        class="pick"
        aria-label={`${formatDayLong(day)}, ${eventsLabel(evs.length)}`}
        onclick={() => onPickDay(day)}
      >
        <span class="num" class:mark={day === today}>{Number(day.slice(8))}</span>
      </button>
      <span class="evs">
        {#each evs.slice(0, MAX) as ev (ev.calendarId + ev.id)}
          <EventChip event={ev} {day} compact />
        {/each}
        {#if evs.length > MAX}<span class="more num">+{evs.length - MAX}</span>{/if}
      </span>
    </div>
  {/each}
</div>

<style>
  /* Las lineas son el hueco de 1px sobre el fondo --line */
  .grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 1px;
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    background: var(--line);
    overflow: hidden;
  }
  .wd {
    padding: var(--sp-2) 0;
    text-align: center;
    font-size: var(--fs-s);
    font-weight: 600;
    color: var(--ink-2);
    background: var(--surface);
  }
  .w-l {
    display: none;
  }
  .cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-1);
    min-width: 0;
    min-height: 3.75rem;
    padding: var(--sp-1);
    position: relative;
    background: var(--surface);
  }
  .cell.weekend {
    background: var(--surface-2);
  }
  .cell.other {
    background: var(--bg);
  }
  .cell.other .num {
    color: var(--ink-2);
  }
  /* El boton cubre toda la celda; los enlaces de evento quedan por encima */
  .pick {
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: inherit;
  }
  .pick::after {
    content: '';
    position: absolute;
    inset: 0;
  }
  .pick:focus-visible {
    outline: none;
  }
  .pick:focus-visible::after {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .num {
    display: inline-block;
    min-width: 1.6rem;
    text-align: center;
    font-size: var(--fs-s);
    font-weight: 600;
    line-height: 1.6rem;
  }
  .evs {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 3px;
    min-width: 0;
  }
  .more {
    color: var(--ink-2);
    font-size: var(--fs-xs);
    font-weight: 600;
  }

  @media (min-width: 700px) {
    .w-s {
      display: none;
    }
    .w-l {
      display: inline;
    }
    .cell {
      align-items: stretch;
      min-height: 7.5rem;
      padding: var(--sp-2);
    }
    .pick {
      align-self: flex-start;
    }
    .evs {
      flex-direction: column;
      flex-wrap: nowrap;
      justify-content: flex-start;
      gap: 2px;
    }
  }
</style>
