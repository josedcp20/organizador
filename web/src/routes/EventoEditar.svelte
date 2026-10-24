<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import {
    AGENDA_WRITE_LIMITS,
    formatDateInTz,
    type AgendaEventPatch,
    type CalendarInfo,
    type EventInfo,
  } from '@organizador/shared';
  import Banner from '../components/Banner.svelte';
  import ConfirmExternal from '../components/ConfirmExternal.svelte';
  import ConflictDialog from '../components/ConflictDialog.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { ApiError } from '../lib/api';
  import { fetchCalendars } from '../lib/calendars';
  import { fetchEvent } from '../lib/eventDetail';
  import {
    buildCreate,
    buildPatch,
    conflictCurrent,
    createEvent,
    defaultForm,
    formFromEvent,
    updateEvent,
    validateForm,
    writeErrorMessage,
    type EventForm,
  } from '../lib/eventWrite';
  import { apiErrorMessage, fetchGoogleStatus } from '../lib/google';
  import { fetchSettings } from '../lib/settings';
  import { eventHref, navigateTo } from '../router';

  let {
    calendarId = '',
    eventId = '',
    date = null,
  }: { calendarId?: string; eventId?: string; date?: string | null } = $props();

  // Sin eventId la pantalla es de alta.
  const editing = $derived(!!eventId);
  const LIMITS = AGENDA_WRITE_LIMITS;

  let loading = $state(true);
  let loadError = $state('');
  let blocked = $state<'' | 'google' | 'nocal' | 'notfound'>('');

  let calendars = $state<CalendarInfo[]>([]);
  let cal = $state('');
  let event = $state<EventInfo | null>(null);
  let calName = $state('');

  let initial = $state<EventForm | null>(null);
  let form = $state<EventForm | null>(null);

  // Generado al abrir el formulario y reutilizado en reintentos: el Worker deduplica por el.
  let clientId = crypto.randomUUID();

  let busy = $state(false);
  let invalid = $state('');
  let failure = $state<{ text: string; retry: boolean; settings: boolean } | null>(null);
  let confirmOpen = $state(false);
  let conflictOpen = $state(false);
  let conflict = $state<EventInfo | null>(null);

  /** Ultimo envio, para Reintentar / Sobrescribir (mismo body, mismo client_id). */
  let lastSend: (() => Promise<EventInfo>) | null = null;
  /** Diff pendiente de confirmar (eventos de Google). */
  let pendingPatch: AgendaEventPatch | null = null;

  let seq = 0;
  let alive = true;
  let controller: AbortController | null = null;

  const readOnly = $derived(
    !event
      ? ''
      : event.recurringEventId
        ? 'recurring'
        : event.frozen
          ? 'frozen'
          : !event.writable
            ? 'reader'
            : '',
  );
  const patch = $derived(editing && initial && form ? buildPatch(initial, form, event ?? undefined) : null);
  const canSave = $derived(!busy && !!form && (!editing || !!patch));
  const dialogSummary = $derived(form?.summary.trim() || event?.summary || '(Sin título)');

  function today(): string {
    return formatDateInTz(new Date());
  }

  function setForm(f: EventForm) {
    initial = { ...f };
    form = { ...f };
  }

  async function load() {
    const mine = ++seq;
    controller?.abort();
    controller = new AbortController();
    loading = true;
    loadError = '';
    blocked = '';
    try {
      if (editing) {
        const [e, cals] = await Promise.all([
          fetchEvent(calendarId, eventId, controller.signal),
          fetchCalendars().catch(() => null),
        ]);
        if (!alive || mine !== seq) return;
        event = e;
        calName = cals?.calendars.find((c) => c.id === calendarId)?.name ?? calendarId;
        setForm(formFromEvent(e));
      } else {
        const [cals, settings, status] = await Promise.all([
          fetchCalendars(),
          fetchSettings().catch(() => null),
          fetchGoogleStatus(),
        ]);
        if (!alive || mine !== seq) return;
        if (!status.connected) {
          blocked = 'google';
          return;
        }
        calendars = cals.calendars.filter((c) => c.writable && c.visible);
        if (calendars.length === 0) {
          blocked = 'nocal';
          return;
        }
        const def = settings?.default_write_calendar;
        cal = calendars.some((c) => c.id === def) ? def! : calendars[0].id;
        const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today();
        setForm(defaultForm(d, new Date()));
      }
    } catch (e) {
      if (!alive || mine !== seq) return;
      if (e instanceof ApiError && e.status === 404) blocked = 'notfound';
      else if (e instanceof ApiError && e.status === 401) return;
      else loadError = `No se pudo cargar. ${apiErrorMessage(e)}`;
    } finally {
      if (alive && mine === seq) loading = false;
    }
  }

  async function send(call: () => Promise<EventInfo>) {
    if (busy) return;
    lastSend = call;
    busy = true;
    failure = null;
    try {
      const saved = await call();
      if (!alive) return;
      done(saved);
    } catch (e) {
      if (!alive) return;
      busy = false;
      fail(e);
    }
  }

  function done(saved: EventInfo) {
    // 201/200 y tambien 202 (pending): el detalle ya muestra "Pendiente".
    const href = eventHref(saved.calendarId, saved.id);
    if (editing && window.history.length > 1) window.history.back();
    else window.location.replace(href);
  }

  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) return;
    if (e instanceof ApiError && e.status === 428) {
      confirmOpen = true;
      return;
    }
    const current = conflictCurrent(e);
    if (current !== undefined) {
      conflict = current;
      conflictOpen = true;
      return;
    }
    if (e instanceof ApiError && e.code === 'duplicate') clientId = crypto.randomUUID();
    const m = writeErrorMessage(e);
    failure = {
      ...m,
      settings: e instanceof ApiError && e.code === 'google_not_connected',
    };
  }

  function sendPatch(confirm: boolean) {
    if (!pendingPatch) return;
    const body: AgendaEventPatch = confirm
      ? { ...pendingPatch, confirm_external: true }
      : pendingPatch;
    void send(() => updateEvent(calendarId, eventId, body));
  }

  function submit() {
    if (busy || !form) return;
    invalid = validateForm(form) ?? '';
    if (invalid) {
      void tick().then(() => document.getElementById('ee-invalid')?.focus());
      return;
    }
    if (!editing) {
      const body = buildCreate(form, cal, clientId);
      void send(() => createEvent(body));
      return;
    }
    if (!patch || readOnly) return;
    pendingPatch = patch;
    if (event?.origin === 'google') confirmOpen = true;
    else sendPatch(false);
  }

  // Reintentar usa el formulario actual (puede haberse corregido tras el error).
  // shortcut: en alta el client_id se reutiliza aunque cambie el body; el Worker devuelve el evento
  // ya creado (idempotente) si el POST anterior si llego, asi que un cambio de titulo tras un fallo
  // incierto no duplica. El calendario se bloquea para que no cambie entre intentos. Revisar si
  // el Worker pasa a rechazar un client_id con body distinto.
  function retry() {
    submit();
  }

  function onConfirm() {
    confirmOpen = false;
    if (editing) sendPatch(true);
  }

  function onUseServer() {
    conflictOpen = false;
    failure = null;
    if (conflict) {
      event = conflict;
      setForm(formFromEvent(conflict));
    }
  }

  function onOverwrite() {
    conflictOpen = false;
    if (lastSend) void send(lastSend);
  }

  function onConflictCancel() {
    conflictOpen = false;
    if (!conflict) failure = { text: 'El evento ya no existe en Google.', retry: false, settings: false };
  }

  function back() {
    if (window.history.length > 1) window.history.back();
    else navigateTo('hoy');
  }

  onMount(() => {
    void load();
  });
  onDestroy(() => {
    alive = false;
    controller?.abort();
  });
</script>

<div class="page">
  <button type="button" class="btn btn-quiet back" aria-label="Volver atrás" onclick={back}>
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M15 5l-7 7 7 7"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    Volver
  </button>

  <PageHeader title={editing ? 'Editar evento' : 'Nuevo evento'} />

  {#if loading}
    <p role="status" class="muted">Cargando...</p>
  {:else if loadError}
    <Banner kind="error">{loadError}</Banner>
    <button type="button" class="btn" onclick={() => load()}>Reintentar</button>
  {:else if blocked === 'google'}
    <Banner kind="warning">
      Google Calendar no está conectado. <a href="#/ajustes">Conéctalo en Ajustes</a> para crear
      eventos.
    </Banner>
  {:else if blocked === 'nocal'}
    <Banner kind="warning">
      No tienes calendarios en los que se pueda escribir. Revisa los calendarios visibles en
      <a href="#/ajustes">Ajustes</a>.
    </Banner>
  {:else if blocked === 'notfound'}
    <Banner kind="error">El evento ya no existe.</Banner>
  {:else if readOnly === 'recurring'}
    <Banner kind="info">
      Los eventos recurrentes se editan desde Google Calendar.
      {#if event?.htmlLink}
        <a href={event.htmlLink} target="_blank" rel="noopener noreferrer">Abrir en Google Calendar</a>
      {/if}
    </Banner>
  {:else if readOnly === 'frozen'}
    <Banner kind="info">Este evento es de hace más de un mes y ya no se puede cambiar.</Banner>
  {:else if readOnly === 'reader'}
    <Banner kind="info">Calendario de solo lectura: este evento no se puede editar.</Banner>
  {:else if form}
    <form
      class="panel"
      novalidate
      aria-describedby={invalid ? 'ee-invalid' : undefined}
      onsubmit={(ev) => {
        ev.preventDefault();
        submit();
      }}
    >
      <div class="field">
        <label for="ee-summary">Título</label>
        <input
          id="ee-summary"
          type="text"
          maxlength={LIMITS.summaryMax}
          required
          aria-invalid={invalid.startsWith('El título') ? 'true' : undefined}
          bind:value={form.summary}
        />
      </div>

      <div class="field">
        <label class="switch" for="ee-allday">
          Todo el día
          <input
            id="ee-allday"
            type="checkbox"
            role="switch"
            bind:checked={form.allDay}
            disabled={editing}
            aria-describedby={editing ? 'ee-allday-help' : undefined}
          />
        </label>
        {#if editing}
          <p class="help" id="ee-allday-help">
            Para cambiar entre día completo y con hora, borra el evento y créalo de nuevo.
          </p>
        {/if}
      </div>

      <div class="pair">
        <div class="field">
          <label for="ee-start-date">{form.allDay ? 'Desde el día' : 'Fecha de inicio'}</label>
          <input id="ee-start-date" class="num" type="date" bind:value={form.startDate} />
        </div>
        {#if !form.allDay}
          <div class="field">
            <label for="ee-start-time">Hora de inicio</label>
            <input id="ee-start-time" class="num" type="time" bind:value={form.startTime} />
          </div>
        {/if}
      </div>

      <div class="pair">
        <div class="field">
          <label for="ee-end-date">{form.allDay ? 'Hasta el día' : 'Fecha de fin'}</label>
          <input id="ee-end-date" class="num" type="date" bind:value={form.endDate} />
        </div>
        {#if !form.allDay}
          <div class="field">
            <label for="ee-end-time">Hora de fin</label>
            <input id="ee-end-time" class="num" type="time" bind:value={form.endTime} />
          </div>
        {/if}
      </div>

      <div class="field">
        <label for="ee-location">Ubicación</label>
        <input
          id="ee-location"
          type="text"
          maxlength={LIMITS.locationMax}
          bind:value={form.location}
        />
      </div>

      <div class="field">
        <label for="ee-description">Descripción (se guarda en Google Calendar)</label>
        <textarea
          id="ee-description"
          rows="4"
          maxlength={LIMITS.descriptionMax}
          bind:value={form.description}
        ></textarea>
      </div>

      <div class="field">
        {#if editing}
          <p class="label-like">Calendario</p>
          <p>{calName}</p>
          <p class="help">Un evento no se puede mover a otro calendario.</p>
        {:else}
          <label for="ee-calendar">Calendario</label>
          <select id="ee-calendar" bind:value={cal} disabled={!!failure?.retry}>
            {#each calendars as c (c.id)}
              <option value={c.id}>{c.name}</option>
            {/each}
          </select>
        {/if}
      </div>

      {#if invalid}<p class="err" id="ee-invalid" role="alert" tabindex="-1">{invalid}</p>{/if}
      {#if failure}
        <Banner kind="error">
          {failure.text}
          {#if failure.settings}<a href="#/ajustes">Ir a Ajustes</a>{/if}
        </Banner>
      {/if}

      <div class="actions">
        {#if failure?.retry}
          <button type="button" class="btn" onclick={retry} disabled={busy}>Reintentar</button>
        {/if}
        <button type="submit" class="btn btn-primary save" disabled={!canSave}>
          {busy ? 'Guardando...' : 'Guardar'}
        </button>
      </div>
    </form>

    <ConfirmExternal
      open={confirmOpen}
      action="edit"
      summary={dialogSummary}
      {onConfirm}
      onCancel={() => (confirmOpen = false)}
    />
    <ConflictDialog
      open={conflictOpen}
      mode="edit"
      current={conflict}
      {onUseServer}
      {onOverwrite}
      onCancel={onConflictCancel}
    />
  {/if}
</div>

<style>
  .back {
    margin-left: calc(-1 * var(--sp-3));
    margin-bottom: var(--sp-2);
    padding: 0 var(--sp-3) 0 var(--sp-2);
    gap: var(--sp-1);
  }
  .panel {
    padding: var(--sp-4);
    border-radius: var(--r-m);
    background: var(--surface);
  }
  .field {
    margin: 0 0 var(--sp-4);
    min-width: 0;
  }
  .field > label:not(.switch),
  .label-like {
    display: block;
    margin-bottom: var(--sp-1);
    font-weight: 600;
  }
  .pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    column-gap: var(--sp-3);
  }
  /* iOS: etiqueta a la izquierda, fecha/hora/selector a la derecha */
  @media (hover: none) and (pointer: coarse) {
    .pair {
      display: block;
    }
    .field:has(> input[type='date'], > input[type='time'], > select) {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-3);
    }
    .field:has(> input[type='date'], > input[type='time'], > select) > label {
      margin-bottom: 0;
    }
    .field > select {
      max-width: 60%;
    }
  }
  .help {
    margin-top: var(--sp-1);
    font-size: var(--fs-s);
    color: var(--ink-2);
  }
  .err {
    color: var(--danger);
    font-size: var(--fs-s);
    margin: 0 0 var(--sp-3);
  }

  .switch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: var(--tap);
    font-weight: 600;
  }
  .switch input {
    appearance: none;
    position: relative;
    flex: none;
    width: 51px;
    height: 31px;
    margin: 0;
    border-radius: 999px;
    background: var(--ink-2);
    cursor: pointer;
    transition: background-color var(--dur) var(--ease);
  }
  .switch input::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    border-radius: 50%;
    background: var(--surface);
    transition: transform var(--dur) var(--ease);
  }
  .switch input:checked {
    background: var(--ok);
  }
  .switch input:checked::after {
    transform: translateX(20px);
  }
  .switch input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    justify-content: flex-end;
  }
  .save {
    flex: 1;
  }
  @media (min-width: 1024px) {
    .save {
      flex: none;
    }
  }
</style>
