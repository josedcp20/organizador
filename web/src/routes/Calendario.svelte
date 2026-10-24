<script lang="ts">
  import { onMount, untrack } from 'svelte';
    import { addDaysToDateStr } from '@organizador/shared';
  import type { EventInfo } from '@organizador/shared';
  import { fetchCalendars } from '../lib/calendars';
  import {
    filterCalendars,
    hiddenCalendars,
    resetFilter,
    showApp,
  } from '../lib/calendarFilter';
  import { apiErrorMessage } from '../lib/google';
  import {
    defaultView,
    fetchEvents,
    fetchRange,
    filterEvents,
    groupByDay,
    mapEvents,
    periodTitle,
    shiftAnchor,
    todayMadrid,
    visibleRange,
    type CalView,
  } from '../lib/events';
  import Banner from '../components/Banner.svelte';
  import { newEventHref } from '../router';
  import PageHeader from '../components/PageHeader.svelte';
  import CalendarFilter from '../components/CalendarFilter.svelte';
  import DayList from '../components/DayList.svelte';
  import MonthGrid from '../components/MonthGrid.svelte';

  const VIEWS: { id: CalView; label: string }[] = [
    { id: 'agenda', label: 'Agenda' },
    { id: 'week', label: 'Semana' },
    { id: 'month', label: 'Mes' },
  ];

  let today = $state(todayMadrid());
  let view = $state<CalView>(defaultView(window.innerWidth));
  let anchor = $state(todayMadrid());
  let raw = $state<EventInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const range = $derived(visibleRange(view, anchor));
  const days = $derived.by(() => {
    const out: string[] = [];
    for (let d = range.from; d <= range.to; d = addDaysToDateStr(d, 1)) out.push(d);
    return out;
  });
  const events = $derived(
    filterEvents(mapEvents(raw), { hiddenCalendars: $hiddenCalendars, showApp: $showApp }),
  );
  const byDay = $derived(groupByDay(events, range.from, range.to));
  const isEmpty = $derived(!loading && !error && byDay.size === 0);

  onMount(() => {
    resetFilter();
    fetchCalendars()
      .then((r) => {
        $filterCalendars = r.calendars.filter((c) => c.visible);
      })
      .catch(() => {
        // El filtro es opcional: sin lista solo queda "Creados en la app".
      });
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      today = todayMadrid();
      // Con error visible no se reintenta solo: el usuario pulsa "Reintentar".
      if (error) return;
      void load(view, anchor);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

  let ctrl: AbortController | null = null;

  async function load(v: CalView, a: string): Promise<void> {
    ctrl?.abort();
    const mine = new AbortController();
    ctrl = mine;
    loading = true;
    error = null;
    const { from, to } = fetchRange(v, a);
    try {
      const res = await fetchEvents(from, to, mine.signal);
      if (mine.signal.aborted) return;
      raw = res.events;
    } catch (e) {
      if (mine.signal.aborted) return;
      error = `No se pudieron cargar los eventos. ${apiErrorMessage(e)}`;
    } finally {
      if (ctrl === mine) loading = false;
    }
  }

  $effect(() => {
    // Unicas dependencias: view y anchor. Todo lo que lee/escribe load() va fuera del seguimiento
    // para que un fallo (error/loading) nunca re-dispare la carga.
    const v = view;
    const a = anchor;
    untrack(() => void load(v, a));
    return () => ctrl?.abort();
  });

  function pickDay(day: string): void {
    anchor = day;
    view = 'agenda';
  }
</script>

<PageHeader title="Calendario">
  {#snippet actions()}
    <a class="btn btn-primary" href={newEventHref(anchor)}>Nuevo evento</a>
  {/snippet}
</PageHeader>

<div class="toolbar">
  <h2 class="period" aria-live="polite">{periodTitle(view, anchor)}</h2>
  <div class="views" role="tablist" aria-label="Vista">
    {#each VIEWS as v (v.id)}
      <button
        type="button"
        role="tab"
        aria-selected={view === v.id}
        class:sel={view === v.id}
        onclick={() => (view = v.id)}>{v.label}</button
      >
    {/each}
  </div>
  <div class="nav">
    <button type="button" class="btn" aria-label="Anterior" onclick={() => (anchor = shiftAnchor(view, anchor, -1))}
      >{@render chevron('M15 5l-7 7 7 7')}</button
    >
    <button type="button" class="btn" onclick={() => (anchor = todayMadrid())}>Hoy</button>
    <button type="button" class="btn" aria-label="Siguiente" onclick={() => (anchor = shiftAnchor(view, anchor, 1))}
      >{@render chevron('M9 5l7 7-7 7')}</button
    >
  </div>
</div>

{#snippet chevron(d: string)}
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path {d} /></svg>
{/snippet}

<CalendarFilter />

{#if error}
  <Banner kind="error">{error}</Banner>
  <button type="button" class="btn" onclick={() => load(view, anchor)}>Reintentar</button>
{/if}

{#if loading}
  <p class="msg" role="status">Cargando eventos...</p>
{/if}

{#if !error}
  <div class="content" class:stale={loading}>
    {#if view === 'month'}
      <MonthGrid from={range.from} month={anchor.slice(0, 7)} {byDay} {today} onPickDay={pickDay} />
    {:else}
      <DayList {days} {byDay} {today} showEmpty={view === 'week'} />
    {/if}
    {#if isEmpty}
      <p class="msg">No hay eventos en este periodo.</p>
    {/if}
  </div>
{/if}

<style>
  /* Movil: periodo arriba, vista segmentada y navegacion debajo. Escritorio: una sola fila. */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-3);
    margin-bottom: var(--sp-4);
  }
  .period {
    flex: 1 1 100%;
    font-size: var(--fs-xl);
  }
  .period::first-letter {
    text-transform: uppercase;
  }
  .views {
    display: flex;
    flex: 1;
    gap: 2px;
    padding: 2px;
    border-radius: var(--r-m);
    background: var(--line);
  }
  .views button {
    flex: 1;
    min-height: 40px;
    padding: 0 var(--sp-3);
    border: 0;
    border-radius: var(--r-s);
    background: transparent;
    color: var(--ink);
    font-weight: 500;
  }
  .views button.sel {
    background: var(--surface);
    font-weight: 700;
  }
  .nav {
    display: flex;
    gap: var(--sp-1);
  }
  .nav .btn {
    min-width: var(--tap);
    padding: 0 var(--sp-3);
  }
  .msg {
    margin: var(--sp-3) 0;
    color: var(--ink-2);
  }
  .content.stale {
    opacity: 0.55;
  }
  .content > :global(.msg) {
    margin-top: var(--sp-4);
  }

  @media (min-width: 1024px) {
    .period {
      flex: 1 1 0;
      min-width: 0;
    }
    .views {
      flex: none;
    }
    .views button {
      min-height: var(--tap);
      padding: 0 var(--sp-4);
    }
  }
</style>
