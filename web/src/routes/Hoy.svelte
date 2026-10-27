<script lang="ts">
  import { onMount } from 'svelte';
  import type { TodayResponse } from '@organizador/shared';
  import Banner from '../components/Banner.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { apiErrorMessage, fetchGoogleStatus } from '../lib/google';
  import { calendarsWithSyncError, fetchCalendars } from '../lib/calendars';
  import DoneToggle from '../components/DoneToggle.svelte';
  import { toggleEventDone } from '../lib/eventDetail';
  import { fetchToday, toRows } from '../lib/today';
  import { eventHref, newEventHref } from '../router';

  let data = $state<TodayResponse | null>(null);
  let loading = $state(true);
  let error = $state('');
  let googleDown = $state(false);
  let syncErrors = $state<string[]>([]);
  let seq = 0;

  async function load() {
    const mine = ++seq;
    loading = true;
    error = '';
    try {
      const [today, status, cals] = await Promise.all([
        fetchToday(),
        fetchGoogleStatus().catch(() => null),
        fetchCalendars().catch(() => null),
      ]);
      if (mine !== seq) return;
      data = today;
      googleDown = !!status && status.configured && !status.connected;
      syncErrors = cals ? calendarsWithSyncError(cals.calendars).map((c) => c.name) : [];
    } catch (e) {
      if (mine !== seq) return;
      error = `No se pudieron cargar los eventos. ${apiErrorMessage(e)}`;
    } finally {
      if (mine === seq) loading = false;
    }
  }

  let doneBusy = $state<Record<string, boolean>>({});
  let doneError = $state('');

  async function toggleDone(calendarId: string, eventId: string, key: string, next: boolean) {
    if (doneBusy[key]) return;
    doneBusy[key] = true;
    doneError = '';
    const apply = (done: boolean) => {
      if (!data) return;
      const upd = (l: TodayResponse['todayEvents']) =>
        l.map((e) => (e.calendarId === calendarId && e.id === eventId ? { ...e, done } : e));
      data = { ...data, todayEvents: upd(data.todayEvents), tomorrowEvents: upd(data.tomorrowEvents) };
    };
    const err = await toggleEventDone(calendarId, eventId, next, apply);
    doneBusy[key] = false;
    if (err) doneError = err;
  }

  const days = $derived(
    data
      ? [
          { label: 'Hoy', date: data.today, rows: toRows(data.todayEvents, data.today), empty: 'Nada hoy' },
          {
            label: 'Mañana',
            date: data.tomorrow,
            rows: toRows(data.tomorrowEvents, data.tomorrow),
            empty: 'Nada mañana',
          },
        ]
      : [],
  );

  function dayParts(date: string) {
    const d = new Date(`${date}T12:00:00`);
    return {
      num: String(Number(date.slice(8, 10))),
      text: d.toLocaleDateString('es-ES', { weekday: 'long', month: 'long' }),
    };
  }

  onMount(() => {
    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });
</script>

<PageHeader title="Hoy">
  {#snippet actions()}
    {#if googleDown}
      <a
        class="btn btn-primary"
        role="link"
        aria-disabled="true"
        aria-describedby="hoy-new-help">Nuevo evento</a
      >
      <p id="hoy-new-help" class="muted">Conecta Google en Ajustes para crear eventos</p>
    {:else}
      <a class="btn btn-primary" href={newEventHref(data?.today)}>Nuevo evento</a>
    {/if}
    <button type="button" class="btn btn-quiet" disabled={loading} onclick={() => load()}>
      {loading ? 'Actualizando...' : 'Actualizar'}
    </button>
  {/snippet}
</PageHeader>

{#if googleDown}
  <Banner kind="warning">
    Google no está conectado, así que los eventos pueden estar desactualizados.
    <a href="#/ajustes">Ir a Ajustes</a>
  </Banner>
{/if}
{#if syncErrors.length > 0}
  <Banner kind="error">
    Error de sincronización en: {syncErrors.join(', ')}. <a href="#/ajustes">Ver Ajustes</a>
  </Banner>
{/if}

{#if error}
  <Banner kind="error">{error}</Banner>
{/if}

{#if doneError}
  <Banner kind="error">{doneError}</Banner>
{/if}

{#if loading && !data}
  <p role="status" class="muted">Cargando...</p>
{/if}

<div class="days">
  {#each days as day, i (day.date)}
    {@const parts = dayParts(day.date)}
    <section aria-labelledby={`day-${day.date}`}>
      <h2 id={`day-${day.date}`} class="day-head" class:soft={i > 0}>
        <span class="num day-num"><span class:mark={i === 0}>{parts.num}</span></span>
        <span class="day-name"><strong>{day.label}</strong> <span class="muted">{parts.text}</span></span>
      </h2>
      {#if day.rows.length === 0}
        <p class="muted empty">{day.empty}</p>
      {:else}
        <ul class="list">
          {#each day.rows as row (row.id)}
            <li class="row" class:done={row.done}>
              <a class="event" href={eventHref(row.calendarId, row.eventId)}>
                <span class="bar" style="--c: {row.color}"></span>
                <time class="time">{row.time}</time>
                <span class="body">
                  <span class="title">{row.title}</span>
                  {#if row.fromApp}<span class="badge">App</span>{/if}
                  {#if row.tentative}<span class="badge">Provisional</span>{/if}
                  {#if row.pending}
                    <span class="icon" role="img" aria-label="Pendiente de sincronizar" title="Pendiente de sincronizar"
                      ><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2" /></svg></span
                    >
                  {/if}
                  {#if row.remind}
                    <span class="icon" role="img" aria-label="Con aviso" title="Con aviso"
                      ><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4" /></svg></span
                    >
                  {/if}
                  {#if row.hasNotes}
                    <span class="icon" role="img" aria-label="Con notas privadas" title="Con notas privadas"
                      ><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 3h9l4 4v14H6zM9 12h7M9 16h5" /></svg></span
                    >
                  {/if}
                  {#if row.location}<span class="loc muted">{row.location}</span>{/if}
                  {#if row.pendingError}
                    <span class="warn">No se pudo enviar a Google: {row.pendingError}</span>
                  {/if}
                </span>
              </a>
              <DoneToggle
                done={row.done}
                busy={!!doneBusy[row.id]}
                title={row.title}
                onToggle={() => toggleDone(row.calendarId, row.eventId, row.id, !row.done)}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
</div>

<style>
  .days {
    display: grid;
    gap: var(--sp-6);
  }

  @media (min-width: 1024px) {
    .days {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: start;
      gap: var(--sp-6) var(--sp-5);
    }
  }

  .day-head {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    margin-bottom: var(--sp-3);
  }

  .day-num {
    font-family: var(--font-display);
    font-size: var(--fs-display);
    font-weight: 800;
    line-height: 1;
  }

  .soft .day-num {
    font-size: var(--fs-2xl);
    font-weight: 600;
    color: var(--ink-2);
  }

  .day-name {
    font-family: var(--font-body);
    font-size: var(--fs-m);
    font-weight: 400;
  }

  .empty {
    max-width: none;
    padding: var(--sp-4);
    border-radius: var(--r-m);
    background: var(--surface);
  }

  .row {
    display: flex;
    align-items: center;
  }
  .row > .event {
    flex: 1;
    width: auto;
    min-width: 0;
    padding-right: 0;
  }
  /* Hecho: atenuado y tachado, en su sitio */
  .done .event > :global(*) {
    opacity: 0.55;
  }
  .done .title {
    text-decoration: line-through;
    text-decoration-thickness: 2px;
  }

  .event {
    gap: var(--sp-3);
    align-items: stretch;
  }

  .time {
    flex: none;
    min-width: 5.5rem;
    color: var(--ink-2);
    font-size: var(--fs-s);
    padding-top: 2px;
  }

  .body {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--sp-2);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .title {
    font-weight: 600;
  }

  .loc {
    flex-basis: 100%;
    font-size: var(--fs-s);
  }

  .icon {
    font-size: var(--fs-s);
    opacity: 0.75;
  }

  .badge {
    padding: 0 var(--sp-2);
    border-radius: var(--r-s);
    background: var(--surface-2);
    color: var(--ink-2);
    font-size: var(--fs-xs);
  }

  .warn {
    flex-basis: 100%;
    color: var(--danger);
    font-size: var(--fs-s);
  }
</style>
