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
  const WEEKDAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const eventsLabel = (n: number) =>
    n === 0 ? 'sin eventos' : n === 1 ? '1 evento' : `${n} eventos`;
  const days = $derived(Array.from({ length: 42 }, (_, i) => addDaysToDateStr(from, i)));
</script>

<div class="grid" role="group" aria-label="Mes">
  {#each WEEKDAYS as w, i (w)}
    <div class="wd" aria-hidden="true" title={WEEKDAY_NAMES[i]}>{w}</div>
  {/each}
  {#each days as day (day)}
    {@const evs = byDay.get(day) ?? []}
    <div class="cell" class:other={!day.startsWith(month)} class:today={day === today}>
      <button
        type="button"
        class="pick"
        aria-label={`${formatDayLong(day)}, ${eventsLabel(evs.length)}`}
        onclick={() => onPickDay(day)}
      >
        <span class="num">{Number(day.slice(8))}</span>
      </button>
      <span class="evs">
        {#each evs.slice(0, MAX) as ev (ev.calendarId + ev.id)}
          <EventChip event={ev} {day} compact />
        {/each}
        {#if evs.length > MAX}<span class="more">+{evs.length - MAX}</span>{/if}
      </span>
    </div>
  {/each}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    border-top: 1px solid #e0e0e0;
    border-left: 1px solid #e0e0e0;
  }
  .wd {
    padding: 0.3rem;
    text-align: center;
    font-size: 0.8rem;
    font-weight: 600;
    color: #666;
    border-right: 1px solid #e0e0e0;
    border-bottom: 1px solid #e0e0e0;
    background: #fafafa;
  }
  .cell {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.2rem;
    min-height: 5.5rem;
    padding: 0.2rem;
    position: relative;
    border-right: 1px solid #e0e0e0;
    border-bottom: 1px solid #e0e0e0;
    background: #fff;
    text-align: left;
    font: inherit;
    color: inherit;
    min-width: 0;
  }
  /* El boton cubre toda la celda; los enlaces de evento quedan por encima */
  .pick {
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: inherit;
    text-align: left;
  }
  .pick::after {
    content: '';
    position: absolute;
    inset: 0;
  }
  .cell.other {
    background: #f7f7f7;
    color: #999;
  }
  .num {
    font-size: 0.85rem;
    width: 1.6rem;
    height: 1.6rem;
    line-height: 1.6rem;
    text-align: center;
    border-radius: 50%;
  }
  .today .num {
    background: #1a73e8;
    color: #fff;
  }
  .evs {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .more {
    font-size: 0.7rem;
    color: #666;
  }
  @media (max-width: 699px) {
    .cell {
      min-height: 3.6rem;
      align-items: center;
    }
    .evs {
      flex-direction: row;
      flex-wrap: wrap;
      justify-content: center;
      gap: 3px;
    }
  }
</style>
