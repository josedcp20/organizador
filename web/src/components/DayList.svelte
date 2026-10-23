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
</script>

<div class="list">
  {#each shown as day (day)}
    <section class="day" class:today={day === today} aria-label={formatDayLong(day)}>
      <h3>{formatDayLong(day)}{day === today ? ' · hoy' : ''}</h3>
      {#each byDay.get(day) ?? [] as ev (ev.calendarId + ev.id)}
        <EventChip event={ev} {day} />
      {:else}
        <p class="none">Sin eventos</p>
      {/each}
    </section>
  {/each}
</div>

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .day {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  h3 {
    margin: 0.25rem 0 0;
    font-size: 0.95rem;
    text-transform: capitalize;
    color: #555;
  }
  .today h3 {
    color: #1a73e8;
  }
  .none {
    margin: 0;
    color: #999;
    font-size: 0.9rem;
  }
</style>
