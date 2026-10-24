<script lang="ts">
  import type { CalEvent } from '../lib/events';
  import { formatDayLong } from '../lib/events';
  import EventChip from './EventChip.svelte';

  let {
    days,
    byDay,
    today,
    showEmpty = false,
  }: {
    days: string[];
    byDay: Map<string, CalEvent[]>;
    today: string;
    showEmpty?: boolean;
  } = $props();

  const shown = $derived(showEmpty ? days : days.filter((d) => byDay.has(d)));

  const wdFmt = new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', weekday: 'long' });
  const moFmt = new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', month: 'long' });
  const at = (d: string) => new Date(`${d}T12:00:00Z`);
</script>

<div class="days">
  {#each shown as day (day)}
    <section class="day" aria-label={formatDayLong(day)}>
      <h3>
        <span class="dn num" class:mark={day === today}>{Number(day.slice(8))}</span>
        <span class="dw">{wdFmt.format(at(day))}</span>
        <span class="dm muted">{moFmt.format(at(day))}</span>
        {#if day === today}<span class="sr-only">(hoy)</span>{/if}
      </h3>
      <ul class="list">
        {#each byDay.get(day) ?? [] as ev (ev.calendarId + ev.id)}
          <li><EventChip event={ev} {day} /></li>
        {:else}
          <li><p class="list-row muted">Sin eventos</p></li>
        {/each}
      </ul>
    </section>
  {/each}
</div>

<style>
  .days {
    display: grid;
    gap: var(--sp-5);
  }
  h3 {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    margin-bottom: var(--sp-2);
    padding: 0 var(--sp-1);
  }
  .dn {
    font-size: var(--fs-xl);
    font-weight: 800;
  }
  .dw {
    font-size: var(--fs-m);
    font-weight: 700;
  }
  .dw::first-letter {
    text-transform: uppercase;
  }
  .dm {
    font-family: var(--font-body);
    font-size: var(--fs-s);
    font-weight: 500;
  }
</style>
