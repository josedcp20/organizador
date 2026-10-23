<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { addDaysToDateStr } from '@organizador/shared';
  import type { CalendarInfo, EventInfo } from '@organizador/shared';
    import { fetchCalendars } from '../lib/calendars';
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
  import CalendarFilter from '../components/CalendarFilter.svelte';
  import DayList from '../components/DayList.svelte';
  import MonthGrid from '../components/MonthGrid.svelte';

  const VIEWS: { id: CalView; label: string }[] = [
    { id: 'month', label: 'Mes' },
    { id: 'week', label: 'Semana' },
    { id: 'agenda', label: 'Agenda' },
  ];

  let today = $state(todayMadrid());
  let view = $state<CalView>(defaultView(window.innerWidth));
  let anchor = $state(todayMadrid());
  let calendars = $state<CalendarInfo[]>([]);
  let raw = $state<EventInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  const hidden = new SvelteSet<string>();
  let showApp = $state(true);

  const range = $derived(visibleRange(view, anchor));
  const days = $derived.by(() => {
    const out: string[] = [];
    for (let d = range.from; d <= range.to; d = addDaysToDateStr(d, 1)) out.push(d);
    return out;
  });
  const events = $derived(
    filterEvents(mapEvents(raw), { hiddenCalendars: hidden, showApp }),
  );
  const byDay = $derived(groupByDay(events, range.from, range.to));
  const isEmpty = $derived(!loading && !error && byDay.size === 0);

  onMount(() => {
    fetchCalendars()
      .then((r) => {
        calendars = r.calendars.filter((c) => c.visible);
      })
      .catch(() => {
        // El filtro es opcional: sin lista solo queda "Creados en la app".
      });
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      today = todayMadrid();
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
    void load(view, anchor);
    return () => ctrl?.abort();
  });

  function toggleCalendar(id: string): void {
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
  }

  function pickDay(day: string): void {
    anchor = day;
    view = 'agenda';
  }
</script>

<div class="page">
  <header class="bar">
    <h1>Calendario</h1>
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
  </header>

  <div class="nav">
    <button type="button" aria-label="Anterior" onclick={() => (anchor = shiftAnchor(view, anchor, -1))}
      >‹</button
    >
    <button type="button" class="todaybtn" onclick={() => (anchor = todayMadrid())}>Hoy</button>
    <button type="button" aria-label="Siguiente" onclick={() => (anchor = shiftAnchor(view, anchor, 1))}
      >›</button
    >
    <h2 class="period" aria-live="polite">{periodTitle(view, anchor)}</h2>
  </div>

  <CalendarFilter
    {calendars}
    {hidden}
    {showApp}
    onToggleCalendar={toggleCalendar}
    onToggleApp={() => (showApp = !showApp)}
  />

  {#if error}
    <div class="msg err" role="alert">
      <p>{error}</p>
      <button type="button" onclick={() => load(view, anchor)}>Reintentar</button>
    </div>
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
</div>

<style>
  .page {
    padding: 0.75rem 1rem 1rem;
    padding-left: max(1rem, env(safe-area-inset-left));
    padding-right: max(1rem, env(safe-area-inset-right));
    max-width: 1100px;
    margin: 0 auto;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  h1 {
    margin: 0;
    font-size: 1.4rem;
  }
  .views {
    display: flex;
    border: 1px solid #ccc;
    border-radius: 8px;
    overflow: hidden;
  }
  .views button {
    min-height: 40px;
    padding: 0 0.9rem;
    border: none;
    background: #fff;
    font-size: 1rem;
  }
  .views button.sel {
    background: #1a73e8;
    color: #fff;
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.6rem 0 0.4rem;
    flex-wrap: wrap;
  }
  .nav button {
    min-width: 44px;
    min-height: 44px;
    border: 1px solid #ccc;
    border-radius: 8px;
    background: #fff;
    font-size: 1.2rem;
  }
  .nav .todaybtn {
    font-size: 1rem;
    padding: 0 0.9rem;
  }
  .period {
    margin: 0;
    font-size: 1.1rem;
    text-transform: capitalize;
    flex: 1;
    min-width: 8rem;
  }
  .msg {
    color: #666;
    margin: 0.75rem 0;
  }
  .msg.err {
    color: #b3261e;
  }
  .msg.err button {
    min-height: 44px;
    padding: 0 1rem;
  }
  .content.stale {
    opacity: 0.55;
  }
</style>
