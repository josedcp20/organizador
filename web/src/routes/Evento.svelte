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
    type MetaField,
    type MetaForm,
  } from '../lib/eventDetail';
  import { apiErrorMessage } from '../lib/google';
  import { navigateTo } from '../router';

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

  let seq = 0;
  let alive = true;
  let controller: AbortController | null = null;

  const recurring = $derived(!!event?.recurringEventId);
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

<div class="container">
  <button type="button" class="back" onclick={back}>&larr; Volver</button>

  {#if loading && !event}
    <p role="status">Cargando...</p>
  {:else if notFound}
    <Banner kind="error">El evento ya no existe.</Banner>
  {:else if loadError}
    <Banner kind="error">{loadError}</Banner>
    <button type="button" class="secondary" onclick={() => load()}>Reintentar</button>
  {:else if event}
    <h1>{title}</h1>

    <section class="card" aria-labelledby="ev-datos">
      <h2 id="ev-datos">Datos de Google Calendar</h2>
      <dl>
        <dt>Fecha y hora</dt>
        <dd>{formatWhen(event)}</dd>
        {#if event.location}
          <dt>Lugar</dt>
          <dd class="text">{event.location}</dd>
        {/if}
        <dt>Calendario</dt>
        <dd>
          <span class="dot" style:background={calColor} aria-hidden="true"></span>
          {calendar?.name ?? calendarId}
        </dd>
      </dl>
      <p class="marks">
        {#if event.origin === 'app'}<span class="badge">Creado en la app</span>{/if}
        {#if event.status === 'tentative'}<span class="badge">Provisional</span>{/if}
      </p>
      {#if event.pending && event.pending.error}
        <p class="err" role="alert">
          No se pudo enviar a Google: {event.pending.error}. Se reintentará.
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

    <section class="card private" aria-labelledby="ev-priv">
      <h2 id="ev-priv">Notas privadas (solo en la app)</h2>
      <p class="muted">Estos datos no se envían a Google Calendar.</p>

      <p class="marks">
        {#if event.metaScopes?.instance}
          <span class="badge">Personalizado en esta instancia</span>
        {/if}
        {#if event.metaScopes?.series}
          <span class="badge">Personalizado en la serie</span>
        {/if}
      </p>

      {#each shadowed as f (f)}
        <p class="warn" data-testid="shadow-warning">
          Esta instancia tiene {SHADOW_TEXT[f]}.
        </p>
      {/each}

      <form
        onsubmit={(ev) => {
          ev.preventDefault();
          save();
        }}
      >
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
          <p class="hint">
            Dejarlo vacío guarda una nota vacía{recurring && scope === 'instance'
              ? ' en esta instancia (tapa la nota de la serie)'
              : ''}. Para volver al valor anterior usa «{inheritLabel}».
          </p>
          {#if stored && stored.notes !== null}
            <button
              type="button"
              class="secondary"
              aria-pressed={!!inherit.notes}
              onclick={() => toggleInherit('notes')}
              disabled={busy !== ''}
            >
              {inherit.notes ? 'Se quitará la nota propia (deshacer)' : inheritLabel + ' (nota)'}
            </button>
          {/if}
        </div>

        <div class="field">
          <label class="check">
            <input
              type="checkbox"
              bind:checked={form.remind}
              onchange={() => edited('remind')}
              disabled={busy !== ''}
            />
            Avisar
          </label>
          {#if stored && stored.remind !== null}
            <button
              type="button"
              class="secondary"
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
              class="swatch"
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
                style:background={c}
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
          <p class="hint">
            {form.color
              ? `Color propio: ${form.color}`
              : 'Sin color propio (se usa el del calendario).'}
          </p>
        </fieldset>

        {#if recurring}
          <fieldset class="field">
            <legend>Guardar en</legend>
            <label class="check">
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
            <label class="check">
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
          </fieldset>
        {/if}

        {#if saveError}<p class="err" role="alert">{saveError}</p>{/if}
        {#if saveOk}<p class="ok" role="status">{saveOk}</p>{/if}

        <div class="actions">
          <button type="submit" disabled={!canSave}>
            {busy === 'save' ? 'Guardando...' : 'Guardar'}
          </button>
          {#if stored}
            <button type="button" class="secondary" onclick={clearScope} disabled={busy !== ''}>
              Quitar personalización{recurring
                ? scope === 'instance'
                  ? ' de esta instancia'
                  : ' de la serie'
                : ''}
            </button>
          {/if}
        </div>
      </form>
    </section>
  {/if}

  {#if notFound}
    <button type="button" class="secondary" onclick={back}>Volver</button>
  {/if}
</div>

<style>
  .container {
    padding: 1rem;
    max-width: 42rem;
  }
  h1 {
    margin: 0.5rem 0 1rem;
    overflow-wrap: anywhere;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0 0 0.5rem;
  }
  h3 {
    font-size: 0.95rem;
    margin: 1rem 0 0.25rem;
  }
  .card {
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }
  .card.private {
    border-color: #188038;
    background: #f4faf5;
  }
  dl {
    margin: 0;
  }
  dt {
    font-size: 0.8rem;
    color: #666;
    margin-top: 0.5rem;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0;
  }
  .dot {
    display: inline-block;
    width: 0.8rem;
    height: 0.8rem;
    border-radius: 50%;
    margin-right: 0.3rem;
  }
  .muted,
  .hint {
    color: #666;
    font-size: 0.85rem;
    margin: 0.25rem 0;
  }
  .err {
    color: #b3261e;
    font-size: 0.9rem;
  }
  .warn {
    color: #8a5300;
    font-size: 0.9rem;
    margin: 0.25rem 0;
  }
  .ok {
    color: #188038;
  }
  .marks {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.4rem 0;
  }
  .badge {
    font-size: 0.75rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: #e0e0e0;
  }
  .field {
    margin: 0 0 1rem;
    padding: 0;
    border: none;
    min-width: 0;
  }
  label,
  legend {
    font-weight: 600;
    padding: 0;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 44px;
    font-weight: normal;
  }
  .check input {
    width: 1.25rem;
    height: 1.25rem;
  }
  textarea,
  input[type='number'] {
    display: block;
    width: 100%;
    font: inherit;
    padding: 0.5rem;
    border: 1px solid #aaa;
    border-radius: 4px;
  }
  input[type='number'] {
    max-width: 8rem;
    min-height: 44px;
  }
  .palette {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
  }
  .swatch {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px #888;
    padding: 0;
    background: #fff;
    color: #555;
    font-size: 1.2rem;
  }
  .swatch[aria-pressed='true'] {
    box-shadow: 0 0 0 3px #1a73e8;
  }
  .custom {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: normal;
  }
  .custom input {
    width: 44px;
    height: 44px;
    padding: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  button {
    min-height: 44px;
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    background: #1a73e8;
    color: #fff;
  }
  button.secondary,
  button.back {
    background: #eee;
    color: #222;
  }
  button.swatch {
    padding: 0;
  }
  button:disabled {
    opacity: 0.6;
  }
</style>
