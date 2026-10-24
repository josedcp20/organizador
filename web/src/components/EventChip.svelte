<script lang="ts">
  import type { CalEvent } from '../lib/events';
  import { eventTimeLabel } from '../lib/events';
  import { eventHref } from '../router';

  let {
    event,
    day,
    compact = false,
  }: { event: CalEvent; day?: string; compact?: boolean } = $props();

  const time = $derived(eventTimeLabel(event, day, compact));

  // Los colores de calendario son arbitrarios: tinta clara u oscura segun la que mas contraste da.
  const LIGHT = '#ffffff';
  const DARK = '#17202b';
  function inkOn(hex: string): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return DARK;
    const [r, g, b] = [0, 2, 4].map((i) => {
      const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return 1.05 / (l + 0.05) >= (l + 0.05) / 0.0635 ? LIGHT : DARK;
  }
  const on = $derived(inkOn(event.color));

  const ICONS = {
    bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4',
    note: 'M6 3h9l4 4v14H6zM9 12h7M9 16h5',
    app: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9L3.5 9.7l5.9-.8z',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    warn: 'M12 3 2.5 20h19zM12 10v4.5M12 17.5h.01',
  } as const;
</script>

{#snippet mark(d: string, label: string, warn = false)}
  <span class="mk" class:warn title={label} role="img" aria-label={label}>
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"><path {d} /></svg
    >
  </span>
{/snippet}

<a
  class="chip"
  href={eventHref(event.calendarId, event.id)}
  class:compact
  class:tentative={event.tentative}
  class:allday={event.allDay || event.multiDay}
  style:--c={event.color}
  style:--on={on}
  data-testid="event-chip"
>
  {#if !compact}<span class="bar" aria-hidden="true"></span>{/if}
  <span class="body">
    {#if time}<span class="time num">{time}</span>{/if}
    <span class="title">{event.title}</span>
    {#if !compact && event.location}<span class="loc">{event.location}</span>{/if}
  </span>
  <span class="marks">
    {#if event.remind}{@render mark(ICONS.bell, 'Con aviso')}{/if}
    {#if event.hasNotes}{@render mark(ICONS.note, 'Con notas privadas')}{/if}
    {#if event.fromApp}{@render mark(ICONS.app, 'Creado en la app')}{/if}
    {#if event.pending && event.pendingError}
      {@render mark(
        ICONS.warn,
        `Aviso: no se pudo guardar en Google (${event.pendingError})`,
        true,
      )}
    {:else if event.pending}
      {@render mark(ICONS.clock, 'Pendiente de enviar a Google')}
    {/if}
  </span>
</a>
{#if !compact && event.pending && event.pendingError}
  <p class="err" role="alert">
    No se pudo guardar en Google ({event.pendingError}). Se reintentara.
  </p>
{/if}

<style>
  .chip {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
    color: var(--ink);
    text-decoration: none;
  }
  .body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .time {
    color: var(--ink-2);
    font-size: var(--fs-s);
    font-weight: 600;
  }
  .title {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .loc {
    color: var(--ink-2);
    font-size: var(--fs-s);
    overflow-wrap: anywhere;
  }
  .marks {
    display: flex;
    gap: var(--sp-2);
    flex: none;
    color: var(--ink-2);
  }
  .mk {
    display: inline-flex;
  }
  .mk.warn {
    color: var(--danger);
  }

  /* Dia completo / multi-dia: bloque solido con el color del calendario */
  .chip.allday {
    background: var(--c);
    color: var(--on);
  }
  .allday .time,
  .allday .loc,
  .allday .marks,
  .allday .mk.warn {
    color: inherit;
  }
  .allday .bar {
    display: none;
  }

  /* Tentativo: discontinuo */
  .tentative .bar {
    background: repeating-linear-gradient(to bottom, var(--c) 0 5px, transparent 5px 8px);
  }
  .chip.allday.tentative {
    outline: 2px dashed var(--on);
    outline-offset: -5px;
  }
  .chip.allday.tentative:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .err {
    padding: 0 var(--sp-4) var(--sp-3);
    color: var(--danger);
    font-size: var(--fs-s);
  }

  /* Compacto: celda del mes en escritorio */
  .chip.compact {
    position: relative;
    z-index: 1;
    gap: var(--sp-1);
    padding: 2px var(--sp-1) 2px 5px;
    border-left: 3px solid var(--c);
    border-radius: var(--r-s);
    background: color-mix(in srgb, var(--c) 16%, var(--surface));
    font-size: var(--fs-xs);
    line-height: 1.3;
  }
  .chip.compact.allday {
    background: var(--c);
  }
  .chip.compact.tentative {
    border-left-style: dashed;
  }
  .compact .body {
    flex-direction: row;
    gap: var(--sp-1);
    overflow: hidden;
  }
  .compact .time {
    flex: none;
    color: inherit;
    font-size: inherit;
  }
  .compact .title {
    overflow: hidden;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .compact .mk :global(svg) {
    width: 12px;
    height: 12px;
  }
  .compact .marks {
    gap: 2px;
    color: inherit;
  }

  /* Movil: la celda del mes solo muestra puntos de color */
  @media (max-width: 699px) {
    .chip.compact {
      width: 8px;
      height: 8px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: var(--c);
      /* El punto no es objetivo tactil: el toque va a la celda (elige el dia) */
      pointer-events: none;
    }
    .compact .body,
    .compact .marks {
      display: none;
    }
  }
</style>
