<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    CALENDAR_PALETTE,
    EVENT_META_LIMITS,
    type CalendarInfo,
    type EventInfo,
    type EventMetaScope,
  } from '@organizador/shared';
  import Banner from '../components/Banner.svelte';
  import ConfirmExternal from '../components/ConfirmExternal.svelte';
  import ConflictDialog from '../components/ConflictDialog.svelte';
  import DoneToggle from '../components/DoneToggle.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { ApiError } from '../lib/api';
  import { fetchCalendars } from '../lib/calendars';
  import {
    buildMetaPatch,
    clearEventMeta,
    fetchEvent,
    formatWhen,
    formForScope,
    saveEventMeta,
    shadowedFields,
    toggleEventDone,
    type MetaField,
    type MetaForm,
  } from '../lib/eventDetail';
  import { conflictCurrent, deleteEvent, writeErrorMessage } from '../lib/eventWrite';
  import { FINAL_ERRORS } from '../lib/events';
  import { apiErrorMessage } from '../lib/google';
  import { editEventHref, navigateTo } from '../router';

  let { calendarId, eventId }: { calendarId: string; eventId: string } = $props();

  const LIMITS = EVENT_META_LIMITS;
  const EMPTY: MetaForm = {
    notes: '',
    remind: false,
    days: LIMITS.remindDaysDefault,
    color: null,
  };

  let event = $state<EventInfo | null>(null);
  let calendar = $state<CalendarInfo | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  let notFound = $state(false);

  let initial = $state<MetaForm>({ ...EMPTY });
  let form = $state<MetaForm>({ ...EMPTY });
  let inherit = $state<Partial<Record<MetaField, boolean>>>({});
  let scope = $state<EventMetaScope>('instance');

  let busy = $state<'' | 'save' | 'clear'>('');
  let saveError = $state('');
  let saveOk = $state('');

  let deleting = $state(false);
  let delError = $state('');
  let extOpen = $state(false);
  let conflictOpen = $state(false);
  let conflictEvent = $state<EventInfo | null>(null);

  let seq = 0;
  let alive = true;
  let controller: AbortController | null = null;

  const recurring = $derived(!!event?.recurringEventId);
  const canWrite = $derived(!!event && event.writable && !event.frozen && !recurring);
  const effScope = $derived<EventMetaScope>(recurring ? scope : 'instance');
  const stored = $derived(event?.metaScopes?.[effScope] ?? null);
  const daysValid = $derived(
    Number.isInteger(form.days) &&
      form.days >= LIMITS.remindDaysMin &&
      form.days <= LIMITS.remindDaysMax,
  );
  // Los dias solo cuentan si se avisa; si no, nunca se envian dias invalidos.
  const daysOk = $derived(!form.remind || daysValid);
  const patch = $derived(
    event
      ? buildMetaPatch(
          effScope,
          initial,
          daysValid ? form : { ...form, days: initial.days },
          inherit,
          stored,
        )
      : null,
  );
  const canSave = $derived(!!patch && daysOk && busy === '');
  const shadowed = $derived<MetaField[]>(
    event && recurring && scope === 'series' ? shadowedFields(event) : [],
  );
  const SHADOW_TEXT: Record<MetaField, string> = {
    notes: 'su propia nota, que tiene prioridad sobre la de la serie',
    remind: 'su propio aviso, que tiene prioridad sobre el de la serie',
    days: 'sus propios días de antelación, que tienen prioridad sobre los de la serie',
    color: 'su propio color, que tiene prioridad sobre el de la serie',
  };
  const inheritLabel = $derived(
    recurring && scope === 'instance' ? 'Heredar de la serie' : 'Quitar valor propio',
  );
  const paletteHas = $derived(
    form.color !== null && CALENDAR_PALETTE.some((c) => c === form.color!.toLowerCase()),
  );
  const calColor = $derived(calendar?.color ?? event?.color ?? '#888');
  const title = $derived(event?.summary?.trim() || '(Sin título)');

  function applyEvent(e: EventInfo) {
    event = e;
    const f = formForScope(e, e.recurringEventId ? scope : 'instance');
    initial = { ...f };
    form = { ...f };
    inherit = {};
  }

  async function load() {
    const mine = ++seq;
    controller?.abort();
    controller = new AbortController();
    loading = true;
    loadError = '';
    notFound = false;
    try {
      const [e, cals] = await Promise.all([
        fetchEvent(calendarId, eventId, controller.signal),
        fetchCalendars().catch(() => null),
      ]);
      if (!alive || mine !== seq) return;
      applyEvent(e);
      calendar = cals?.calendars.find((c) => c.id === calendarId) ?? null;
    } catch (e) {
      if (!alive || mine !== seq) return;
      if (e instanceof ApiError && e.status === 404) notFound = true;
      else if (e instanceof ApiError && e.status === 401) return;
      else loadError = `No se pudo cargar el evento. ${apiErrorMessage(e)}`;
    } finally {
      if (alive && mine === seq) loading = false;
    }
  }

  function failMessage(e: unknown): string {
    if (e instanceof ApiError && e.status === 400) {
      return 'Los datos no son válidos. Revisa el formulario.';
    }
    return `No se pudo guardar. ${apiErrorMessage(e)}`;
  }

  async function run(kind: 'save' | 'clear', call: () => Promise<EventInfo>) {
    const mine = ++seq;
    busy = kind;
    saveError = '';
    saveOk = '';
    try {
      const updated = await call();
      if (!alive || mine !== seq) return;
      applyEvent(updated);
      saveOk = kind === 'save' ? 'Guardado.' : 'Personalización quitada.';
    } catch (e) {
      if (!alive || mine !== seq) return;
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 404) {
        event = null;
        notFound = true;
        return;
      }
      saveError = failMessage(e); // el formulario se conserva
    } finally {
      if (alive && mine === seq) busy = '';
    }
  }

  function save() {
    if (!patch || !daysOk) return;
    const body = patch;
    void run('save', () => saveEventMeta(calendarId, eventId, body));
  }

  function clearScope() {
    const s = effScope;
    void run('clear', () => clearEventMeta(calendarId, eventId, s));
  }

  let doneBusy = $state(false);
  let doneError = $state('');

  async function toggleDone() {
    if (!event || doneBusy) return;
    doneBusy = true;
    doneError = '';
    const err = await toggleEventDone(calendarId, eventId, !event.done, (done) => {
      if (event) event = { ...event, done };
    });
    doneBusy = false;
    if (err) doneError = err;
  }

  function leave() {
    if (window.history.length > 1) window.history.back();
    else navigateTo('calendario');
  }

  async function doDelete(confirmExternal: boolean) {
    deleting = true;
    delError = '';
    try {
      await deleteEvent(calendarId, eventId, confirmExternal);
      if (alive) leave();
    } catch (e) {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 410) return leave(); // ya borrado: exito
      if (e instanceof ApiError && e.status === 404) {
        notFound = true;
        return;
      }
      const cur = conflictCurrent(e);
      if (cur !== undefined) {
        conflictEvent = cur;
        conflictOpen = true;
      } else if (e instanceof ApiError && e.status === 428) extOpen = true;
      else if (!(e instanceof ApiError && e.status === 401)) delError = writeErrorMessage(e).text;
    } finally {
      if (alive) deleting = false;
    }
  }

  function askDelete() {
    if (!event) return;
    if (event.origin === 'google') extOpen = true;
    else if (window.confirm('¿Borrar este evento?')) void doDelete(false);
  }

  function back() {
    if (window.history.length > 1) window.history.back();
    else navigateTo('hoy');
  }

  function toggleInherit(field: MetaField) {
    inherit = { ...inherit, [field]: !inherit[field] };
    saveOk = '';
  }
  function edited(field: MetaField) {
    if (inherit[field]) inherit = { ...inherit, [field]: false };
    saveOk = '';
  }
  function setScope(s: EventMetaScope, ev: Event) {
    if (s === scope || !event) return;
    const dirty = patch !== null || Object.values(inherit).some(Boolean);
    if (dirty && !window.confirm('Hay cambios sin guardar. ¿Descartarlos y cambiar de ámbito?')) {
      // conserva el ambito y los cambios: restaura los radios
      const radios = (ev.currentTarget as HTMLInputElement)
        .closest('fieldset')
        ?.querySelectorAll<HTMLInputElement>('input[name="scope"]');
      radios?.forEach((r) => (r.checked = r.value === scope));
      return;
    }
    scope = s;
    const f = formForScope(event, s);
    initial = { ...f };
    form = { ...f };
    inherit = {};
    saveOk = '';
    saveError = '';
  }
  function pickColor(c: string | null) {
    form.color = c;
    edited('color');
  }
  function onCustomColor(e: Event) {
    pickColor((e.currentTarget as HTMLInputElement).value);
  }
  function onDays(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    form.days = v === '' ? Number.NaN : Number(v);
    edited('days');
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

  {#if loading && !event}
    <PageHeader title="Evento" />
    <p role="status" class="muted">Cargando...</p>
  {:else if notFound}
    <PageHeader title="Evento" />
    <Banner kind="error">El evento ya no existe.</Banner>
  {:else if loadError}
    <PageHeader title="Evento" />
    <Banner kind="error">{loadError}</Banner>
    <button type="button" class="btn" onclick={() => load()}>Reintentar</button>
  {:else if event}
    <PageHeader {title} />

    <div class="done-row" class:done={event.done}>
      <DoneToggle done={event.done === true} busy={doneBusy} {title} onToggle={toggleDone} />
      <span>{event.done ? '✓ Hecho' : 'Marcar como hecho'}</span>
    </div>
    {#if doneError}<Banner kind="error">{doneError}</Banner>{/if}

    {#if canWrite}
      <div class="ev-actions">
        <a
          class="btn"
          role={deleting ? "link" : undefined}
          href={deleting ? undefined : editEventHref(calendarId, eventId)}
          aria-disabled={deleting}>Editar</a
        >
        <button type="button" class="btn btn-danger" onclick={askDelete} disabled={deleting}>
          {deleting ? 'Borrando...' : 'Borrar'}
        </button>
      </div>
    {:else}
      <p class="muted" data-testid="readonly-note">
        {recurring
          ? 'Los eventos recurrentes se editan desde Google Calendar.'
          : event.frozen
            ? 'Este evento es antiguo y no se puede modificar.'
            : 'Este evento es de solo lectura.'}
      </p>
    {/if}
    {#if delError}<Banner kind="error">{delError}</Banner>{/if}

    <ConfirmExternal
      open={extOpen}
      action="delete"
      summary={title}
      onConfirm={() => {
        extOpen = false;
        void doDelete(true);
      }}
      onCancel={() => (extOpen = false)}
    />
    <ConflictDialog
      open={conflictOpen}
      mode="delete"
      current={conflictEvent}
      onUseServer={() => {
        conflictOpen = false;
        void load();
      }}
      onOverwrite={() => {
        conflictOpen = false;
        void doDelete(event?.origin === 'google');
      }}
      onCancel={() => {
        conflictOpen = false;
        if (conflictEvent === null) notFound = true;
      }}
    />

    <div class="cols">
      <section class="panel" aria-labelledby="ev-datos">
        <h2 id="ev-datos">Datos de Google Calendar</h2>
        <div class="head">
          <span class="bar" style="--c: {calColor}" aria-hidden="true"></span>
          <div class="head-text">
            <p class="when num"><time>{formatWhen(event)}</time></p>
            {#if event.location}
              <p class="text where">{event.location}</p>
            {/if}
            <p class="cal-name muted">{calendar?.name ?? calendarId}</p>
          </div>
        </div>
        {#if event.origin === 'app' || event.status === 'tentative'}
          <p class="marks">
            {#if event.origin === 'app'}<span class="pill">Creado en la app</span>{/if}
            {#if event.status === 'tentative'}<span class="pill">Provisional</span>{/if}
          </p>
        {/if}
        {#if event.pending && event.pending.error}
          <p class="err" role="alert">
            No se pudo enviar a Google: {event.pending.error}.
            {FINAL_ERRORS.has(event.pending.error)
              ? 'No se reintentará: edítalo de nuevo o revísalo en Google.'
              : 'Se reintentará.'}
          </p>
        {:else if event.pending}
          <p class="muted" role="status">Pendiente de enviar a Google.</p>
        {/if}
        <h3>Descripción (de Google Calendar)</h3>
        {#if event.description}
          <p class="text">{event.description}</p>
        {:else}
          <p class="muted">Sin descripción.</p>
        {/if}
      </section>

      <section class="panel private" aria-labelledby="ev-priv">
        <h2 id="ev-priv">Notas privadas (solo en la app)</h2>
        <p class="muted">Estos datos no se envían a Google Calendar.</p>

        {#if event.metaScopes?.instance || event.metaScopes?.series}
          <p class="marks">
            {#if event.metaScopes?.instance}
              <span class="pill">Personalizado en esta instancia</span>
            {/if}
            {#if event.metaScopes?.series}
              <span class="pill">Personalizado en la serie</span>
            {/if}
          </p>
        {/if}

        {#each shadowed as f (f)}
          <p class="help warn" data-testid="shadow-warning">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path d="M12 11v5M12 8v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
            <span>Esta instancia tiene {SHADOW_TEXT[f]}.</span>
          </p>
        {/each}

        <form
          onsubmit={(ev) => {
            ev.preventDefault();
            save();
          }}
        >
          {#if recurring}
            <fieldset class="field">
              <legend>Guardar en</legend>
              <div class="segmented">
                <label class:on={scope === 'instance'}>
                  <input
                    type="radio"
                    name="scope"
                    value="instance"
                    checked={scope === 'instance'}
                    onchange={(ev) => setScope('instance', ev)}
                    disabled={busy !== ''}
                  />
                  Solo esta instancia
                </label>
                <label class:on={scope === 'series'}>
                  <input
                    type="radio"
                    name="scope"
                    value="series"
                    checked={scope === 'series'}
                    onchange={(ev) => setScope('series', ev)}
                    disabled={busy !== ''}
                  />
                  Toda la serie
                </label>
              </div>
            </fieldset>
          {/if}

          <div class="field">
            <label for="ev-notes">Notas</label>
            <textarea
              id="ev-notes"
              rows="5"
              maxlength={LIMITS.notesMaxLength}
              bind:value={form.notes}
              oninput={() => edited('notes')}
              disabled={busy !== ''}
            ></textarea>
            <p class="help">
              Dejarlo vacío guarda una nota vacía{recurring && scope === 'instance'
                ? ' en esta instancia (tapa la nota de la serie)'
                : ''}. Para volver al valor anterior usa «{inheritLabel}».
            </p>
            {#if stored && stored.notes !== null}
              <button
                type="button"
                class="btn btn-quiet"
                aria-pressed={!!inherit.notes}
                onclick={() => toggleInherit('notes')}
                disabled={busy !== ''}
              >
                {inherit.notes ? 'Se quitará la nota propia (deshacer)' : inheritLabel + ' (nota)'}
              </button>
            {/if}
          </div>

          <div class="field">
            <label class="switch">
              Avisar
              <input
                type="checkbox"
                role="switch"
                bind:checked={form.remind}
                onchange={() => edited('remind')}
                disabled={busy !== ''}
              />
            </label>
            {#if stored && stored.remind !== null}
              <button
                type="button"
                class="btn btn-quiet"
                aria-pressed={!!inherit.remind}
                onclick={() => toggleInherit('remind')}
                disabled={busy !== ''}
              >
                {inherit.remind ? 'Se quitará el aviso propio (deshacer)' : inheritLabel + ' (aviso)'}
              </button>
            {/if}
          </div>

          {#if form.remind}
            <div class="field">
              <label for="ev-days">Días de antelación</label>
              <input
                id="ev-days"
                class="days num"
                type="number"
                inputmode="numeric"
                min={LIMITS.remindDaysMin}
                max={LIMITS.remindDaysMax}
                step="1"
                value={Number.isNaN(form.days) ? '' : form.days}
                oninput={onDays}
                disabled={busy !== ''}
              />
              {#if !daysValid}
                <p class="err" role="alert">
                  Indica un número entero entre {LIMITS.remindDaysMin} y {LIMITS.remindDaysMax}.
                </p>
              {/if}
            </div>
          {/if}

          <fieldset class="field">
            <legend>Color</legend>
            <div class="palette">
              <button
                type="button"
                class="swatch none"
                aria-pressed={form.color === null}
                aria-label="Sin color propio"
                title="Sin color propio"
                onclick={() => pickColor(null)}
                disabled={busy !== ''}>&times;</button
              >
              {#each CALENDAR_PALETTE as c (c)}
                <button
                  type="button"
                  class="swatch"
                  style="--c: {c}"
                  aria-pressed={form.color?.toLowerCase() === c}
                  aria-label={`Color ${c}`}
                  onclick={() => pickColor(c)}
                  disabled={busy !== ''}
                ></button>
              {/each}
              <label class="custom">
                Personalizado
                <input
                  type="color"
                  value={form.color && !paletteHas ? form.color : '#1a73e8'}
                  oninput={onCustomColor}
                  disabled={busy !== ''}
                />
              </label>
            </div>
            <p class="help">
              {form.color
                ? `Color propio: ${form.color}`
                : 'Sin color propio (se usa el del calendario).'}
            </p>
          </fieldset>

          {#if saveError}<p class="err" role="alert">{saveError}</p>{/if}
          {#if saveOk}<p class="ok" role="status">{saveOk}</p>{/if}

          <div class="actions">
            {#if stored}
              <button type="button" class="btn btn-quiet" onclick={clearScope} disabled={busy !== ''}>
                Quitar personalización{recurring
                  ? scope === 'instance'
                    ? ' de esta instancia'
                    : ' de la serie'
                  : ''}
              </button>
            {/if}
            <button type="submit" class="btn btn-primary save" disabled={!canSave}>
              {busy === 'save' ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </section>
    </div>
  {/if}

  {#if notFound}
    <button type="button" class="btn" onclick={back}>Volver</button>
  {/if}
</div>

<style>
  .back {
    margin-left: calc(-1 * var(--sp-3));
    margin-bottom: var(--sp-2);
    padding: 0 var(--sp-3) 0 var(--sp-2);
    gap: var(--sp-1);
  }
  .done-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-weight: 600;
  }
  /* Hecho: la fecha y los datos de Google, atenuados y tachados */
  .done-row.done ~ .cols :global(.when) {
    opacity: 0.55;
    text-decoration: line-through;
  }
  .ev-actions {
    display: flex;
    gap: var(--sp-2);
    margin-bottom: var(--sp-4);
  }
  .cols {
    display: grid;
    gap: var(--sp-5);
    align-items: start;
  }
  .panel {
    padding: var(--sp-4);
    border-radius: var(--r-m);
    background: var(--surface);
  }
  .panel h2 {
    font-size: var(--fs-l);
    margin-bottom: var(--sp-3);
  }
  .panel h3 {
    font-size: var(--fs-m);
    margin: var(--sp-5) 0 var(--sp-1);
  }
  /* Marca sutil: esto se queda en la app y no va a Google */
  .private {
    background: var(--accent-soft);
    border-left: 4px solid var(--accent);
  }
  .head {
    display: flex;
    gap: var(--sp-3);
  }
  .head-text {
    min-width: 0;
  }
  .when {
    font-family: var(--font-display);
    font-size: var(--fs-xl);
    font-weight: 700;
    line-height: var(--lh-display);
    overflow-wrap: anywhere;
  }
  .where {
    margin-top: var(--sp-1);
    font-size: var(--fs-l);
  }
  .cal-name {
    margin-top: var(--sp-1);
    font-size: var(--fs-s);
  }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .marks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    margin: var(--sp-3) 0;
  }
  .pill {
    padding: 0 var(--sp-2);
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--ink-2);
    font-size: var(--fs-xs);
  }
  .help {
    margin-top: var(--sp-1);
    font-size: var(--fs-s);
    color: var(--ink-2);
  }
  .help.warn {
    display: flex;
    gap: var(--sp-2);
    align-items: flex-start;
    margin: var(--sp-3) 0;
  }
  .help.warn svg {
    flex: none;
    margin-top: 2px;
  }
  .err {
    color: var(--danger);
    font-size: var(--fs-s);
    margin-top: var(--sp-2);
  }
  .ok {
    color: var(--ok);
    margin-top: var(--sp-2);
  }
  .field {
    margin: 0 0 var(--sp-4);
    padding: 0;
    border: 0;
    min-width: 0;
  }
  .field > label:not(.switch),
  legend {
    display: block;
    padding: 0;
    margin-bottom: var(--sp-1);
    font-weight: 600;
  }
  .days {
    max-width: 8rem;
  }

  .segmented {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 3px;
    border-radius: var(--r-s);
    background: var(--surface);
    border: 1px solid var(--line);
  }
  .segmented label {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 40px;
    padding: 0 var(--sp-2);
    border-radius: 4px;
    text-align: center;
    font-weight: 600;
    font-size: var(--fs-s);
    cursor: pointer;
  }
  .segmented label.on {
    background: var(--accent);
    color: var(--accent-ink);
  }
  .segmented input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .segmented label:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
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

  .palette {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    margin: 0 calc(-1 * var(--sp-1));
  }
  .swatch {
    position: relative;
    width: var(--tap);
    height: var(--tap);
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink-2);
    font-size: var(--fs-l);
  }
  .swatch::before {
    content: '';
    position: absolute;
    inset: 6px;
    border-radius: 50%;
    background: var(--c, var(--surface));
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.18);
  }
  .swatch.none::before {
    border: 1px dashed var(--ink-2);
    box-shadow: none;
  }
  .swatch[aria-pressed='true']::before {
    box-shadow:
      0 0 0 2px var(--accent-soft),
      0 0 0 4px var(--ink);
  }
  .swatch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .custom {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    margin-left: var(--sp-2);
    font-weight: 400;
    font-size: var(--fs-s);
  }
  .custom input {
    width: var(--tap);
    height: var(--tap);
    padding: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
    /* Pegajoso sobre la barra de pestanas; deja hueco al boton flotante de nota rapida */
    position: sticky;
    bottom: calc(var(--tabs-h, 60px) + var(--safe-bottom));
    margin: 0 calc(-1 * var(--sp-4)) calc(-1 * var(--sp-4));
    padding: var(--sp-3) calc(56px + var(--sp-5)) var(--sp-3) var(--sp-4);
    background: var(--accent-soft);
    border-top: 1px solid var(--line);
  }
  .save {
    flex: 1;
  }

  @media (min-width: 1024px) {
    .cols {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .actions {
      position: static;
      justify-content: flex-end;
      margin: 0;
      padding: 0;
      border: 0;
      background: none;
    }
    .save {
      flex: none;
    }
  }
</style>
