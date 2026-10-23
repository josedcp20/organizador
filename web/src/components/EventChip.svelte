<script lang="ts">
  import type { CalEvent } from '../lib/events';

  let { event, compact = false }: { event: CalEvent; compact?: boolean } = $props();

  const time = $derived(
    event.allDay || !event.startTime
      ? ''
      : compact || !event.endTime
        ? event.startTime
        : `${event.startTime} - ${event.endTime}`,
  );
</script>

<span
  class="chip"
  class:compact
  class:tentative={event.tentative}
  class:allday={event.allDay || event.multiDay}
  style:--c={event.color}
  data-testid="event-chip"
>
  <span class="body">
    {#if time}<span class="time">{time}</span>{/if}
    <span class="title">{event.title}</span>
    {#if !compact && event.location}<span class="loc">{event.location}</span>{/if}
  </span>
  <span class="marks">
    {#if event.fromApp}
      <span class="mark" title="Creado en la app" role="img" aria-label="Creado en la app">★</span>
    {/if}
    {#if event.pending && event.pendingError}
      <span
        class="mark warn"
        title={`No se pudo guardar en Google: ${event.pendingError}`}
        role="img"
        aria-label={`Aviso: no se pudo guardar en Google (${event.pendingError})`}>⚠</span
      >
    {:else if event.pending}
      <span
        class="mark"
        title="Pendiente de enviar a Google"
        role="img"
        aria-label="Pendiente de enviar a Google">🕒</span
      >
    {/if}
  </span>
</span>
{#if !compact && event.pending && event.pendingError}
  <p class="err" role="alert">
    No se pudo guardar en Google ({event.pendingError}). Se reintentara.
  </p>
{/if}

<style>
  .chip {
    display: flex;
    box-sizing: border-box;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    border-radius: 8px;
    background: color-mix(in srgb, var(--c) 14%, #fff);
    border-left: 4px solid var(--c);
    font-size: 1rem;
    line-height: 1.3;
    min-width: 0;
  }
  .chip.allday {
    background: var(--c);
    color: #fff;
  }
  .chip.tentative {
    border-left-style: dashed;
    opacity: 0.8;
  }
  .body {
    display: flex;
    flex-wrap: wrap;
    gap: 0.1rem 0.5rem;
    flex: 1;
    min-width: 0;
  }
  .time {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .title {
    overflow-wrap: anywhere;
  }
  .loc {
    flex-basis: 100%;
    font-size: 0.85rem;
    opacity: 0.75;
  }
  .marks {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }
  .mark {
    font-size: 0.9rem;
  }
  .mark.warn {
    color: #b3261e;
  }
  .allday .mark.warn {
    color: #ffd8d4;
  }
  .err {
    margin: 0.2rem 0 0;
    font-size: 0.85rem;
    color: #b3261e;
  }

  .chip.compact {
    padding: 0.05rem 0.3rem;
    font-size: 0.75rem;
    border-radius: 4px;
    border-left-width: 3px;
    gap: 0.25rem;
  }
  .compact .body {
    flex-wrap: nowrap;
    overflow: hidden;
  }
  .compact .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .compact .mark {
    font-size: 0.65rem;
  }

  /* En movil la celda del mes solo muestra puntos de color */
  @media (max-width: 699px) {
    .chip.compact {
      width: 0.7rem;
      height: 0.7rem;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: var(--c);
    }
    .compact .body,
    .compact .marks {
      display: none;
    }
  }
</style>
