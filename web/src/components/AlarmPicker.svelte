<script lang="ts">
  import { ALARM_STEP_MIN } from '@organizador/shared';
  import { isPushEnabledHere } from '../lib/push';
  import { defaultAlarmLocal, roundAlarmLocal, toMadridLocalInput } from '../lib/notes';

  // `value`: 'YYYY-MM-DDTHH:mm' (hora de Madrid, minutos de 10 en 10) o '' = sin alarma.
  // Selects en vez de datetime-local: iOS no respeta step en su rueda nativa.
  let {
    value = $bindable(''),
    idPrefix = 'al',
  }: { value?: string; idPrefix?: string } = $props();

  const initial = roundAlarmLocal(value) || defaultAlarmLocal();
  let enabled = $state(value !== '');
  let date = $state(initial.slice(0, 10));
  let hour = $state(initial.slice(11, 13));
  let minute = $state(initial.slice(14, 16));

  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const minutes = Array.from({ length: 60 / ALARM_STEP_MIN }, (_, i) =>
    String(i * ALARM_STEP_MIN).padStart(2, '0'),
  );
  const min = toMadridLocalInput(Date.now()).slice(0, 10);
  const noPush = $derived(enabled && !isPushEnabledHere());

  $effect(() => {
    value = enabled && date ? `${date}T${hour}:${minute}` : '';
  });
</script>

<div class="alarm">
  <label class="check">
    <input type="checkbox" bind:checked={enabled} aria-label="Activar alarma" /> Alarma
  </label>
  {#if enabled}
    <div class="row">
      <input id={`${idPrefix}-date`} type="date" {min} bind:value={date} aria-label="Fecha de la alarma" />
      <select bind:value={hour} aria-label="Hora de la alarma">
        {#each hours as h (h)}<option value={h}>{h}</option>{/each}
      </select>
      <span aria-hidden="true">:</span>
      <select bind:value={minute} aria-label="Minutos de la alarma">
        {#each minutes as m (m)}<option value={m}>{m}</option>{/each}
      </select>
      <button type="button" class="btn btn-quiet" onclick={() => (enabled = false)}>Quitar alarma</button>
    </div>
    {#if noPush}
      <p class="hint" role="note">Activa las notificaciones en Ajustes para que suene.</p>
    {/if}
  {/if}
</div>

<style>
  .alarm {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: var(--tap);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
  }

  .hint {
    color: var(--warn);
    font-size: var(--fs-s);
  }
</style>
