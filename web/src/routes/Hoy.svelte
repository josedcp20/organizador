<script lang="ts">
  import { onMount } from 'svelte';
  import type { TodayResponse } from '@organizador/shared';
  import Banner from '../components/Banner.svelte';
  import { apiErrorMessage, fetchGoogleStatus } from '../lib/google';
  import { calendarsWithSyncError, fetchCalendars } from '../lib/calendars';
  import { fetchToday, toRows } from '../lib/today';

  let title = 'Hoy';

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

  onMount(() => {
    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });
</script>

<div class="container">
  <div class="head">
    <h1>{title}</h1>
    <button type="button" disabled={loading} onclick={() => load()}>
      {loading ? 'Actualizando...' : 'Actualizar'}
    </button>
  </div>

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

  {#if loading && !data}
    <p role="status">Cargando...</p>
  {/if}

  {#each days as day (day.date)}
    <section aria-labelledby={`day-${day.date}`}>
      <h2 id={`day-${day.date}`}>{day.label} <small>{day.date}</small></h2>
      {#if day.rows.length === 0}
        <p class="muted">{day.empty}</p>
      {:else}
        <ul class="events">
          {#each day.rows as row (row.id)}
            <li class="event" style:border-left-color={row.color}>
              <span class="time">{row.time}</span>
              <span class="body">
                <span class="title">{row.title}</span>
                {#if row.fromApp}<span class="badge">App</span>{/if}
                {#if row.tentative}<span class="badge">Provisional</span>{/if}
                {#if row.pending}
                  <span
                    class="pending"
                    role="img"
                    aria-label="Pendiente de sincronizar"
                    title="Pendiente de sincronizar">&#9201;</span
                  >
                {/if}
                {#if row.location}<span class="loc">{row.location}</span>{/if}
                {#if row.pendingError}
                  <span class="warn" role="alert"
                    >No se pudo enviar a Google: {row.pendingError}</span
                  >
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
</div>

<style>
  .container {
    padding: 1rem;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }

  h1 {
    margin: 0 0 1rem 0;
  }

  h2 {
    font-size: 1.15rem;
    margin: 1rem 0 0.5rem;
  }

  small,
  .muted {
    color: #666;
    font-weight: normal;
  }

  button {
    padding: 0.5rem 1rem;
    background-color: #1a73e8;
    color: white;
    border: none;
    border-radius: 4px;
    min-height: 44px;
  }

  button:disabled {
    opacity: 0.6;
  }

  ul.events {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .event {
    display: flex;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.4rem;
    border-left: 5px solid #1a73e8;
    background: #f7f7f7;
    border-radius: 4px;
  }

  .time {
    flex: none;
    min-width: 5.5rem;
    font-variant-numeric: tabular-nums;
    color: #444;
  }

  .body {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.5rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .title {
    font-weight: 600;
  }

  .loc {
    flex-basis: 100%;
    color: #666;
    font-size: 0.9rem;
  }

  .badge {
    font-size: 0.7rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: #e0e0e0;
    color: #333;
  }

  .warn {
    flex-basis: 100%;
    color: #8a1c13;
    font-size: 0.85rem;
  }
</style>
